#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSuitePath = resolve(repoRoot, "evaluation", "gsc-smoke.json");

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameValues(actual, expected) {
  return JSON.stringify(sortedUnique(actual)) === JSON.stringify(sortedUnique(expected));
}

function canonicalToolName(name) {
  return String(name)
    .trim()
    .split(/__|\./)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase();
}

function flattenObservations(value, prefix = "", result = []) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenObservations(child, prefix ? `${prefix}.${key}` : key, result);
    }
    return result;
  }
  result.push([prefix, value]);
  return result;
}

function valueAtPath(value, path) {
  return path.split(".").reduce(
    (current, key) => (current !== null && typeof current === "object" ? current[key] : undefined),
    value,
  );
}

function validateSuite(suite) {
  expect(suite?.schema_version === 1, "suite schema_version must be 1");
  expect(typeof suite.suite_id === "string" && suite.suite_id, "suite_id is required");
  expect(typeof suite.target?.repository === "string", "target.repository is required");
  expect(typeof suite.target?.project_name === "string", "target.project_name is required");
  if (suite.target.revision !== undefined) {
    expect(
      typeof suite.target.revision === "string" && suite.target.revision,
      "target.revision must be a non-empty string",
    );
  }
  expect(suite.conditions && typeof suite.conditions === "object", "conditions are required");
  expect(Array.isArray(suite.tasks) && suite.tasks.length > 0, "tasks must be a non-empty array");

  const ids = new Set();
  for (const task of suite.tasks) {
    expect(typeof task.id === "string" && task.id, "every task needs an id");
    expect(!ids.has(task.id), `duplicate task id: ${task.id}`);
    ids.add(task.id);
    expect(/^D[1-5]$/.test(task.dimension), `${task.id}: dimension must be D1 through D5`);
    expect(typeof task.prompt === "string" && task.prompt, `${task.id}: prompt is required`);
    expect(task.oracle && typeof task.oracle === "object", `${task.id}: oracle is required`);
    expect(
      ["exact", "contains"].includes(task.oracle.files?.mode),
      `${task.id}: oracle.files.mode must be exact or contains`,
    );
    expect(Array.isArray(task.oracle.files.values), `${task.id}: oracle.files.values must be an array`);
    expect(
      task.oracle.observations && typeof task.oracle.observations === "object",
      `${task.id}: oracle.observations is required`,
    );
  }
}

function validateRun(run, suite) {
  expect(run?.schema_version === 1, "run schema_version must be 1");
  expect(run.suite_id === suite.suite_id, `run suite_id must be ${suite.suite_id}`);
  expect(suite.conditions[run.condition], `unknown condition: ${run.condition}`);
  expect(typeof run.run_id === "string" && run.run_id, "run_id is required");
  expect(typeof run.model === "string" && run.model, "model is required");
  expect(
    typeof run.repository_revision === "string" && run.repository_revision,
    "repository_revision is required",
  );
  if (suite.target.revision) {
    expect(
      run.repository_revision === suite.target.revision,
      `run repository_revision must be ${suite.target.revision}`,
    );
  }
  expect(Array.isArray(run.answers), "answers must be an array");

  const expectedIds = suite.tasks.map((task) => task.id);
  const actualIds = run.answers.map((answer) => answer.task_id);
  expect(sameValues(actualIds, expectedIds), "answers must contain every suite task exactly once");
  expect(new Set(actualIds).size === actualIds.length, "answers contain duplicate task ids");

  for (const answer of run.answers) {
    expect(typeof answer.answer === "string", `${answer.task_id}: answer must be a string`);
    expect(Array.isArray(answer.files), `${answer.task_id}: files must be an array`);
    expect(
      answer.observations && typeof answer.observations === "object",
      `${answer.task_id}: observations must be an object`,
    );
    expect(Array.isArray(answer.tool_calls), `${answer.task_id}: tool_calls must be an array`);
  }
}

function check(name, passed, expected, actual) {
  return { name, passed, expected, actual };
}

function scoreTask(task, answer) {
  const checks = [];
  const actualFiles = sortedUnique(answer.files.map(String));
  const expectedFiles = sortedUnique(task.oracle.files.values.map(String));

  for (const file of expectedFiles) {
    checks.push(check(`file:${file}`, actualFiles.includes(file), true, actualFiles.includes(file)));
  }
  if (task.oracle.files.mode === "exact") {
    checks.push(check("files:no-extras", sameValues(actualFiles, expectedFiles), expectedFiles, actualFiles));
  }

  for (const [path, expected] of flattenObservations(task.oracle.observations)) {
    const actual = valueAtPath(answer.observations, path);
    checks.push(check(`observation:${path}`, Object.is(actual, expected), expected, actual));
  }

  const passed = checks.filter((item) => item.passed).length;
  return {
    task_id: task.id,
    dimension: task.dimension,
    score: checks.length === 0 ? 0 : passed / checks.length,
    passed_checks: passed,
    total_checks: checks.length,
    checks,
  };
}

function auditTools(run, suite) {
  const forbidden = new Set(
    suite.conditions[run.condition].forbidden_tools.map((name) => canonicalToolName(name)),
  );
  const calls = run.answers.flatMap((answer) => answer.tool_calls.map(canonicalToolName));
  const violations = calls.filter((name) => forbidden.has(name));
  return {
    condition_valid: violations.length === 0,
    tool_calls: calls.length,
    violations: sortedUnique(violations),
  };
}

function scoreRun(run, suite) {
  validateRun(run, suite);
  const byId = new Map(run.answers.map((answer) => [answer.task_id, answer]));
  const tasks = suite.tasks.map((task) => scoreTask(task, byId.get(task.id)));
  const toolAudit = auditTools(run, suite);
  const quality = tasks.reduce((sum, task) => sum + task.score, 0) / tasks.length;

  return {
    suite_id: suite.suite_id,
    run_id: run.run_id,
    condition: run.condition,
    model: run.model,
    repository_revision: run.repository_revision,
    condition_valid: toolAudit.condition_valid,
    tool_violations: toolAudit.violations,
    quality,
    metrics: {
      wall_ms: Number(run.metrics?.wall_ms || 0),
      input_tokens: Number(run.metrics?.input_tokens || 0),
      output_tokens: Number(run.metrics?.output_tokens || 0),
      tool_calls: toolAudit.tool_calls,
    },
    tasks,
  };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareRuns(runs, suite) {
  const scores = runs.map((run) => scoreRun(run, suite));
  const conditions = {};
  for (const name of Object.keys(suite.conditions)) {
    const group = scores.filter((score) => score.condition === name && score.condition_valid);
    conditions[name] = {
      valid_runs: group.length,
      invalid_runs: scores.filter((score) => score.condition === name && !score.condition_valid).length,
      quality: mean(group.map((score) => score.quality)),
      wall_ms: mean(group.map((score) => score.metrics.wall_ms)),
      total_tokens: mean(
        group.map((score) => score.metrics.input_tokens + score.metrics.output_tokens),
      ),
      tool_calls: mean(group.map((score) => score.metrics.tool_calls)),
    };
  }

  const graph = conditions.graph;
  const explorer = conditions.explorer;
  return {
    suite_id: suite.suite_id,
    conditions,
    deltas: {
      quality_graph_minus_explorer:
        graph?.quality !== null && explorer?.quality !== null
          ? graph.quality - explorer.quality
          : null,
      speed_explorer_over_graph:
        graph?.wall_ms > 0 && explorer?.wall_ms > 0 ? explorer.wall_ms / graph.wall_ms : null,
      tokens_explorer_over_graph:
        graph?.total_tokens > 0 && explorer?.total_tokens > 0
          ? explorer.total_tokens / graph.total_tokens
          : null,
    },
    runs: scores,
  };
}

function promptFor(conditionName, suite) {
  const condition = suite.conditions[conditionName];
  expect(condition, `unknown condition: ${conditionName}`);
  const taskTemplate = {
    task_id: "<task id>",
    answer: "<concise prose with evidence>",
    files: ["<repository-relative evidence path>"],
    observations: {
      "<requested field>": "<structured answer using the field names suggested by the question>"
    },
    tool_calls: ["<code-discovery tool name>"]
  };
  const runTemplate = {
    schema_version: 1,
    suite_id: suite.suite_id,
    run_id: "<unique run id>",
    condition: conditionName,
    model: "<model identifier>",
    repository_revision: "<git SHA or immutable fixture id>",
    metrics: {
      wall_ms: 0,
      input_tokens: 0,
      output_tokens: 0
    },
    answers: [taskTemplate]
  };

  return [
    `Suite: ${suite.suite_id}`,
    `Condition: ${conditionName} — ${condition.description}`,
    `Target repository: ${suite.target.repository}`,
    `Target revision: ${suite.target.revision ?? "<provided separately>"}`,
    `Graph project name: ${suite.target.project_name}`,
    "",
    "Rules:",
    ...condition.instructions.map((instruction) => `- ${instruction}`),
    "- Do not inspect evaluation suite JSON files; they contain hidden scoring oracles.",
    "- Complete every task and return exactly one JSON object with no Markdown fence.",
    "",
    "Tasks:",
    ...suite.tasks.flatMap((task, index) => [
      `${index + 1}. [${task.id} / ${task.dimension}] ${task.prompt}`,
      `   Observation fields: ${
        flattenObservations(task.oracle.observations).map(([path]) => path).join(", ")
      }`,
    ]),
    "",
    "Result shape:",
    JSON.stringify(runTemplate, null, 2),
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const suiteFlag = args.indexOf("--suite");
  let suitePath = defaultSuitePath;
  if (suiteFlag !== -1) {
    expect(args[suiteFlag + 1], "--suite requires a path");
    suitePath = resolve(args[suiteFlag + 1]);
    args.splice(suiteFlag, 2);
  }
  return { args, suitePath };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/gsc-agent-eval.mjs validate [run.json] [--suite suite.json]",
    "  node scripts/gsc-agent-eval.mjs self-test [--suite suite.json]",
    "  node scripts/gsc-agent-eval.mjs prompt <graph|explorer> [--suite suite.json]",
    "  node scripts/gsc-agent-eval.mjs score <run.json> [--suite suite.json]",
    "  node scripts/gsc-agent-eval.mjs compare <run.json>... [--suite suite.json]",
  ].join("\n");
}

try {
  const { args, suitePath } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args;
  const suite = readJson(suitePath);
  validateSuite(suite);

  if (command === "validate") {
    if (rest[0]) {
      validateRun(readJson(resolve(rest[0])), suite);
      console.log(`valid run: ${rest[0]}`);
    } else {
      console.log(`valid suite: ${suite.suite_id} (${suite.tasks.length} tasks)`);
    }
  } else if (command === "self-test") {
    expect(rest.length === 0, usage());
    const fixture = readJson(resolve(repoRoot, "test", "fixtures", "agent-eval", "scorer-pass.json"));
    const perfect = scoreRun(fixture, suite);
    expect(perfect.condition_valid, "self-test: valid tool usage was rejected");
    expect(perfect.quality === 1, "self-test: perfect fixture did not score 1");

    const pinnedSuite = structuredClone(suite);
    pinnedSuite.target.revision = fixture.repository_revision;
    validateSuite(pinnedSuite);
    validateRun(fixture, pinnedSuite);
    expect(
      promptFor("graph", pinnedSuite).includes(`Target revision: ${fixture.repository_revision}`),
      "self-test: pinned revision is missing from the generated prompt",
    );
    const wrongRevision = structuredClone(fixture);
    wrongRevision.repository_revision = "wrong-revision";
    let rejectedWrongRevision = false;
    try {
      validateRun(wrongRevision, pinnedSuite);
    } catch (error) {
      rejectedWrongRevision = error.message.includes("repository_revision");
    }
    expect(rejectedWrongRevision, "self-test: wrong repository revision was accepted");

    const leaking = structuredClone(fixture);
    leaking.answers[0].tool_calls.push("functions.exec_command");
    expect(
      !scoreRun(leaking, suite).condition_valid,
      "self-test: forbidden cross-condition tool was not detected",
    );

    const incorrect = structuredClone(fixture);
    incorrect.answers[0].observations.definition_count = 999;
    expect(scoreRun(incorrect, suite).quality < 1, "self-test: incorrect fact scored as perfect");
    console.log("agent-eval scorer: perfect, incorrect, and tool-leakage checks passed");
  } else if (command === "prompt") {
    expect(rest.length === 1, usage());
    console.log(promptFor(rest[0], suite));
  } else if (command === "score") {
    expect(rest.length === 1, usage());
    console.log(JSON.stringify(scoreRun(readJson(resolve(rest[0])), suite), null, 2));
  } else if (command === "compare") {
    expect(rest.length >= 1, usage());
    console.log(
      JSON.stringify(compareRuns(rest.map((path) => readJson(resolve(path))), suite), null, 2),
    );
  } else {
    fail(usage());
  }
} catch (error) {
  console.error(`gsc-agent-eval: ${error.message}`);
  process.exitCode = 1;
}
