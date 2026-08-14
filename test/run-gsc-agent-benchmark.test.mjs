import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditToolEvents,
  codexConfig,
  extractToolEvents,
  infrastructureFailure,
  parseJsonl,
  parseUsage,
  scheduleFor,
  shouldRetryAttempt,
  spawnProcess,
  validateFinalResponse,
} from "../scripts/run-gsc-agent-benchmark.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const suite = JSON.parse(
  await readFile(resolve(repoRoot, "evaluation", "zpam3-v1.json"), "utf8"),
);
const schema = JSON.parse(
  await readFile(resolve(repoRoot, "evaluation", "agent-run.schema.json"), "utf8"),
);
const fakeCodex = resolve(
  repoRoot,
  "test",
  "fixtures",
  "agent-benchmark",
  "fake-codex.mjs",
);

const expected = {
  run_id: "test-run",
  condition: "graph",
  model: "gpt-5.6-sol",
  repository_revision: suite.target.revision,
};
const firstTaskId = suite.tasks[0].id;

function validResponse(overrides = {}) {
  return {
    schema_version: 1,
    suite_id: suite.suite_id,
    run_id: expected.run_id,
    condition: expected.condition,
    model: expected.model,
    repository_revision: expected.repository_revision,
    metrics: {
      wall_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
    answers: Object.fromEntries(
      suite.tasks.map((task) => [
        task.id,
        {
          answer: "fixture answer",
          files: [],
          observations: structuredClone(task.oracle.observations),
          tool_calls: [],
        },
      ]),
    ),
    ...overrides,
  };
}

test("fake Codex success output and usage are captured", async () => {
  const result = await spawnProcess(process.execPath, [fakeCodex, "--scenario", "success"], {
    timeoutMs: 2_000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  const parsed = parseJsonl(result.stdout);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parseUsage(parsed.events), {
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 25,
    reasoning_output_tokens: 10,
    total_tokens: 125,
  });
});

test("malformed JSONL is retained as a transport error", async () => {
  const result = await spawnProcess(process.execPath, [fakeCodex, "--scenario", "malformed"]);
  const parsed = parseJsonl(result.stdout);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].line, 2);
});

test("nonzero Codex exit is captured without throwing", async () => {
  const result = await spawnProcess(process.execPath, [fakeCodex, "--scenario", "nonzero"]);
  assert.equal(result.code, 17);
  assert.match(result.stderr, /synthetic Codex failure/);
});

test("timeout terminates and then force-kills an uncooperative Codex", async () => {
  const result = await spawnProcess(process.execPath, [fakeCodex, "--scenario", "timeout"], {
    timeoutMs: 60,
    killGraceMs: 40,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.forced, true);
  assert.equal(result.signal, "SIGKILL");
});

test("strict response validation accepts one copy of all 20 tasks", () => {
  assert.deepEqual(validateFinalResponse(validResponse(), suite, expected), []);
});

test("strict response validation rejects malformed identity fields", () => {
  for (const [field, value] of [
    ["condition", "explorer"],
    ["model", "wrong-model"],
    ["repository_revision", "wrong-revision"],
  ]) {
    const errors = validateFinalResponse(validResponse({ [field]: value }), suite, expected);
    assert.ok(errors.some((error) => error.startsWith(`${field} must be`)), field);
  }
});

test("strict response validation rejects missing tasks", () => {
  const response = validResponse();
  delete response.answers[suite.tasks.at(-1).id];
  const errors = validateFinalResponse(response, suite, expected);
  assert.ok(errors.some((error) => /found 0/.test(error)));
});

test("strict response validation rejects duplicate tasks", () => {
  const response = validResponse();
  response.answers = suite.tasks.map((task) => ({
    task_id: task.id,
    ...structuredClone(response.answers[task.id]),
  }));
  response.answers[19] = structuredClone(response.answers[0]);
  const errors = validateFinalResponse(response, suite, expected);
  assert.ok(errors.some((error) => /object keyed by task ID/.test(error)));
  assert.ok(errors.some((error) => /found 2/.test(error)));
  assert.ok(errors.some((error) => /found 0/.test(error)));
});

test("committed schema requires every suite task exactly once", () => {
  const taskIds = suite.tasks.map((task) => task.id);
  assert.equal(schema.properties.answers.type, "object");
  assert.equal(schema.properties.answers.additionalProperties, false);
  assert.deepEqual([...schema.properties.answers.required].sort(), [...taskIds].sort());
  assert.deepEqual(Object.keys(schema.properties.answers.properties).sort(), [...taskIds].sort());
  assert.deepEqual(schema.properties.condition.enum, ["graph", "explorer", "hybrid"]);
  for (const id of taskIds) {
    assert.equal(schema.properties.answers.properties[id].$ref, `#/$defs/answer-${id}`);
    assert.equal(schema.$defs[`answer-${id}`].additionalProperties, false);
  }

  const unsupported = new Set([
    "allOf",
    "contains",
    "minContains",
    "maxContains",
    "uniqueItems",
    "minItems",
    "maxItems",
  ]);
  const found = [];
  const visit = (value, path = "$") => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (unsupported.has(key)) found.push(`${path}.${key}`);
      visit(item, `${path}.${key}`);
    }
  };
  visit(schema);
  assert.deepEqual(found, []);
});

test("condition configuration exposes the intended graph and shell tool families", () => {
  const common = {
    model: expected.model,
    reasoningEffort: "xhigh",
    cbmBinary: "/fixture/codebase-memory-mcp",
    cacheDir: "/fixture/cache",
    corpus: "/fixture/corpus",
  };
  const graph = codexConfig({ condition: "graph", ...common });
  const explorer = codexConfig({ condition: "explorer", ...common });
  const hybrid = codexConfig({ condition: "hybrid", ...common });
  assert.match(graph, /shell_tool = false/);
  assert.match(graph, /unified_exec = false/);
  assert.match(graph, /enabled = true/);
  assert.match(graph, /default_tools_approval_mode = "approve"/);
  assert.match(explorer, /shell_tool = true/);
  assert.match(explorer, /unified_exec = true/);
  assert.match(explorer, /enabled = false/);
  assert.match(hybrid, /shell_tool = true/);
  assert.match(hybrid, /unified_exec = true/);
  assert.match(hybrid, /enabled = true/);
  assert.match(hybrid, /default_tools_approval_mode = "approve"/);
});

test("hybrid-only schedule never launches graph-only or explorer conditions", () => {
  assert.deepEqual(scheduleFor(5, { hybridOnly: true }), [
    { pair: 1, conditions: ["hybrid"] },
    { pair: 2, conditions: ["hybrid"] },
    { pair: 3, conditions: ["hybrid"] },
    { pair: 4, conditions: ["hybrid"] },
    { pair: 5, conditions: ["hybrid"] },
  ]);
});

test("only infrastructure failures are eligible for retry", () => {
  assert.equal(shouldRetryAttempt({ infrastructure_failure: false }, 0, 2), false);
  assert.equal(shouldRetryAttempt({ infrastructure_failure: true }, 0, 2), true);
  assert.equal(shouldRetryAttempt({ infrastructure_failure: true }, 2, 2), false);
  assert.equal(
    infrastructureFailure(
      {
        code: 1,
        timedOut: false,
        spawnError: null,
        stderr: "Warning: temporary directory\ninvalid_json_schema",
        stdout: "",
      },
      [],
    ),
    false,
  );
  assert.equal(
    infrastructureFailure(
      {
        code: 1,
        timedOut: false,
        spawnError: null,
        stderr: "service returned HTTP status 503",
        stdout: "",
      },
      [],
    ),
    true,
  );
});

test("actual graph condition shell use is forbidden", async () => {
  const text = await readFile(
    resolve(repoRoot, "test", "fixtures", "agent-benchmark", "tool-events.jsonl"),
    "utf8",
  );
  const calls = extractToolEvents(parseJsonl(text).events);
  const response = validResponse();
  response.answers[firstTaskId].tool_calls = ["search_graph", "exec_command"];
  const audit = auditToolEvents({
    condition: "graph",
    toolEvents: calls.filter((call) => call.id !== "oracle-1"),
    finalResponse: response,
  });
  assert.equal(audit.valid, false);
  assert.ok(
    audit.violations.some(
      (violation) => violation.kind === "forbidden_tool" && violation.tool === "exec_command",
    ),
  );
});

test("graph MCP resource inventories are neutral when fully self-reported", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        id: "graph-1",
        type: "mcp_tool_call",
        server: "codebase_memory",
        tool: "search_graph",
        arguments: {},
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "resource-1",
        type: "mcp_tool_call",
        server: "",
        tool: "list_mcp_resources",
        arguments: {},
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "resource-2",
        type: "mcp_tool_call",
        server: "",
        tool: "list_mcp_resource_templates",
        arguments: {},
        status: "completed",
      },
    },
  ];
  const response = validResponse();
  response.answers[firstTaskId].tool_calls = [
    "search_graph",
    "list_mcp_resources",
    "list_mcp_resource_templates",
  ];
  const audit = auditToolEvents({
    condition: "graph",
    toolEvents: extractToolEvents(events),
    finalResponse: response,
  });
  assert.equal(audit.valid, true);
});

test("graph run without an evidence-bearing call is invalid", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        id: "resource-1",
        type: "mcp_tool_call",
        server: "",
        tool: "list_mcp_resources",
        arguments: {},
        status: "completed",
      },
    },
  ];
  const response = validResponse();
  response.answers[firstTaskId].tool_calls = ["list_mcp_resources"];
  const audit = auditToolEvents({
    condition: "graph",
    toolEvents: extractToolEvents(events),
    finalResponse: response,
  });
  assert.equal(audit.valid, false);
  assert.equal(audit.graph_evidence_calls, 0);
  assert.ok(audit.violations.some((violation) => violation.kind === "missing_graph_evidence"));
});

test("cancelled graph evidence is retained and classified as infrastructure failure", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        id: "graph-1",
        type: "mcp_tool_call",
        server: "codebase_memory",
        tool: "search_graph",
        arguments: { query: "target" },
        status: "failed",
        error: { message: "user cancelled MCP tool call" },
      },
    },
  ];
  const response = validResponse();
  response.answers[firstTaskId].tool_calls = ["search_graph"];
  const calls = extractToolEvents(events);
  const audit = auditToolEvents({
    condition: "graph",
    toolEvents: calls,
    finalResponse: response,
  });
  assert.deepEqual(calls[0].error, { message: "user cancelled MCP tool call" });
  assert.equal(audit.valid, false);
  assert.equal(audit.infrastructure_failure, true);
  assert.equal(audit.graph_evidence_calls, 1);
  assert.equal(audit.successful_graph_evidence_calls, 0);
  assert.ok(
    audit.violations.some(
      (violation) => violation.kind === "graph_tool_infrastructure_failure",
    ),
  );
  assert.ok(
    audit.violations.some((violation) => violation.kind === "no_successful_graph_evidence"),
  );
});

test("hybrid condition requires and accepts successful graph plus explorer evidence", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        id: "graph-1",
        type: "mcp_tool_call",
        server: "codebase_memory",
        tool: "search_graph",
        arguments: { query: "target" },
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "shell-1",
        type: "command_execution",
        command: "rg target source",
        aggregated_output: "source/file.gsc:1:target",
        exit_code: 0,
        status: "completed",
      },
    },
  ];
  const response = validResponse({ condition: "hybrid" });
  response.answers[firstTaskId].tool_calls = ["search_graph", "exec_command"];
  const audit = auditToolEvents({
    condition: "hybrid",
    toolEvents: extractToolEvents(events),
    finalResponse: response,
  });
  assert.equal(audit.valid, true);
  assert.equal(audit.successful_graph_evidence_calls, 1);
  assert.equal(audit.successful_explorer_evidence_calls, 1);
});

test("hybrid condition is invalid when either evidence family is missing", () => {
  const graphEvent = {
    type: "item.completed",
    item: {
      id: "graph-1",
      type: "mcp_tool_call",
      server: "codebase_memory",
      tool: "search_graph",
      arguments: {},
      status: "completed",
    },
  };
  const shellEvent = {
    type: "item.completed",
    item: {
      id: "shell-1",
      type: "command_execution",
      command: "rg target source",
      aggregated_output: "",
      exit_code: 0,
      status: "completed",
    },
  };

  const graphOnlyResponse = validResponse({ condition: "hybrid" });
  graphOnlyResponse.answers[firstTaskId].tool_calls = ["search_graph"];
  const graphOnly = auditToolEvents({
    condition: "hybrid",
    toolEvents: extractToolEvents([graphEvent]),
    finalResponse: graphOnlyResponse,
  });
  assert.ok(
    graphOnly.violations.some((violation) => violation.kind === "missing_explorer_evidence"),
  );

  const shellOnlyResponse = validResponse({ condition: "hybrid" });
  shellOnlyResponse.answers[firstTaskId].tool_calls = ["exec_command"];
  const shellOnly = auditToolEvents({
    condition: "hybrid",
    toolEvents: extractToolEvents([shellEvent]),
    finalResponse: shellOnlyResponse,
  });
  assert.ok(shellOnly.violations.some((violation) => violation.kind === "missing_graph_evidence"));
});

test("controller detects self-reported versus actual tool mismatch", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        id: "graph-1",
        type: "mcp_tool_call",
        server: "codebase_memory",
        tool: "search_graph",
        arguments: {},
        status: "completed",
      },
    },
  ];
  const response = validResponse();
  response.answers[firstTaskId].tool_calls = ["query_graph"];
  const audit = auditToolEvents({
    condition: "graph",
    toolEvents: extractToolEvents(events),
    finalResponse: response,
  });
  const mismatch = audit.violations.find(
    (violation) => violation.kind === "tool_report_mismatch",
  );
  assert.deepEqual(mismatch.omitted, ["search_graph"]);
  assert.deepEqual(mismatch.overreported, ["query_graph"]);
});

test("controller rejects oracle-bearing path access", async () => {
  const text = await readFile(
    resolve(repoRoot, "test", "fixtures", "agent-benchmark", "tool-events.jsonl"),
    "utf8",
  );
  const oracleCall = extractToolEvents(parseJsonl(text).events).find(
    (call) => call.id === "oracle-1",
  );
  const response = validResponse();
  response.answers[firstTaskId].tool_calls = ["exec_command"];
  const audit = auditToolEvents({
    condition: "explorer",
    toolEvents: [oracleCall],
    finalResponse: response,
  });
  assert.ok(audit.violations.some((violation) => violation.kind === "oracle_access"));
});

test("explorer condition rejects actual codebase-memory use", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        id: "graph-1",
        type: "mcp_tool_call",
        server: "codebase_memory",
        tool: "trace_path",
        arguments: {},
        status: "completed",
      },
    },
  ];
  const response = validResponse({ condition: "explorer" });
  response.answers[firstTaskId].tool_calls = ["trace_path"];
  const audit = auditToolEvents({
    condition: "explorer",
    toolEvents: extractToolEvents(events),
    finalResponse: response,
  });
  assert.ok(audit.violations.some((violation) => violation.kind === "forbidden_tool"));
});
