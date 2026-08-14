#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSuitePath = resolve(repoRoot, "evaluation", "zpam3-v1.json");
const defaultSchemaPath = resolve(repoRoot, "evaluation", "agent-run.schema.json");
const defaultCbmRoot = resolve(repoRoot, "..", "codebase-memory-mcp");
const defaultResultsRoot = resolve(repoRoot, "evaluation", "results", "zpam3");
const harnessPath = resolve(repoRoot, "scripts", "gsc-agent-eval.mjs");
const overlayPath = resolve(repoRoot, "evaluation", "zpam3.codebase-memory.json");
const runnerPath = fileURLToPath(import.meta.url);

const GRAPH_TOOLS = [
  "get_architecture",
  "get_code_snippet",
  "get_graph_schema",
  "index_status",
  "list_projects",
  "query_graph",
  "search_graph",
  "trace_path",
];
const GRAPH_NEUTRAL_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates"];
const EXPLORER_TOOLS = ["exec_command", "read_file", "grep", "glob", "find"];
const CONDITION_NAMES = ["graph", "explorer", "hybrid"];

const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "remote_plugin",
];

const REQUIRED_EXEC_FLAGS = [
  "--ephemeral",
  "--strict-config",
  "--model",
  "--config",
  "--sandbox",
  "--cd",
  "--json",
  "--output-schema",
  "--output-last-message",
  "--ignore-rules",
];

const SCHEDULE = [
  ["graph", "explorer"],
  ["explorer", "graph"],
  ["graph", "explorer"],
  ["explorer", "graph"],
  ["graph", "explorer"],
];
const HYBRID_SCHEDULE = Array.from({ length: 5 }, () => ["hybrid"]);

const EXPECTED_D4_EDGES = [
  ["source/maps/mp/mp_toujane.gsc", "maps\\mp\\_bug_fix", "toujane", "source/maps/mp/_bug_fix.gsc"],
  [
    "source/maps/mp/mp_toujane.gsc",
    "maps\\mp\\mp_toujane_fx",
    "main",
    "source/maps/mp/mp_toujane_fx.gsc",
  ],
  ["source/maps/mp/mp_toujane.gsc", "maps\\mp\\_load", "main", "source/maps/mp/_load.gsc"],
  [
    "source/maps/mp/_load.gsc",
    "maps\\mp\\_minefields",
    "minefields",
    "source/maps/mp/_minefields.gsc",
  ],
  ["source/maps/mp/_load.gsc", "maps\\mp\\_shutter", "main", "source/maps/mp/_shutter.gsc"],
  [
    "source/maps/mp/mp_rhine.gsc",
    "maps\\mp\\mp_rhine_fx",
    "main",
    "source/maps/mp/mp_rhine_fx.gsc",
  ],
  ["source/maps/mp/mp_rhine.gsc", "maps\\mp\\_load", "main", "source/maps/mp/_load.gsc"],
];

const ORACLE_PATH_PATTERNS = [
  /(?:^|[^A-Za-z0-9_.-])evaluation[\\/](?:zpam3-v1\.json|gsc-smoke\.json|agent-run\.schema\.json)/i,
  /(?:^|[^A-Za-z0-9_.-])scripts[\\/]gsc-agent-eval\.mjs/i,
  /(?:^|[^A-Za-z0-9_.-])test[\\/]fixtures[\\/]agent-eval/i,
  /(?:^|[^A-Za-z0-9_.-])evaluation[\\/]results/i,
  /SOL-5\.6-XHIGH-BENCHMARK-PLAN\.md/i,
  /scorer-pass\.json/i,
];

const BOOLEAN_OPTIONS = new Set([
  "dry-run",
  "help",
  "hybrid-only",
  "resume",
  "smoke-only",
]);

const ALLOWED_OPTIONS = {
  preflight: new Set([
    "suite",
    "schema",
    "corpus",
    "cbm-root",
    "codex",
    "timeout-ms",
    "help",
  ]),
  run: new Set([
    "suite",
    "schema",
    "corpus",
    "cbm-root",
    "codex",
    "model",
    "reasoning-effort",
    "repetitions",
    "seed",
    "timeout-ms",
    "kill-grace-ms",
    "max-infrastructure-retries",
    "results-root",
    "cohort-dir",
    "dry-run",
    "hybrid-only",
    "resume",
    "smoke-only",
    "help",
  ]),
  summarize: new Set(["suite", "help"]),
};

let activeChild = null;
let requestedSignal = null;

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  await writeFile(temporary, typeof value === "string" ? value : json(value), { mode });
  await rename(temporary, path);
}

function parseInteger(value, name, { minimum = 0 } = {}) {
  const parsed = Number(value);
  expect(Number.isSafeInteger(parsed) && parsed >= minimum, `${name} must be an integer >= ${minimum}`);
  return parsed;
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", options: {}, positionals: [] };
  }
  expect(ALLOWED_OPTIONS[command], `unknown command: ${command}\n\n${usage()}`);
  const options = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [rawName, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);
    expect(ALLOWED_OPTIONS[command].has(rawName), `unknown ${command} option: --${rawName}`);
    if (BOOLEAN_OPTIONS.has(rawName)) {
      expect(inlineValue === undefined, `--${rawName} does not take a value`);
      options[rawName] = true;
      continue;
    }
    const value = inlineValue ?? rest[++index];
    expect(value !== undefined && !value.startsWith("--"), `--${rawName} requires a value`);
    options[rawName] = value;
  }
  return { command, options, positionals };
}

function commonOptions(options) {
  return {
    suitePath: resolve(options.suite ?? defaultSuitePath),
    schemaPath: resolve(options.schema ?? defaultSchemaPath),
    corpus: options.corpus ? resolve(options.corpus) : null,
    cbmRoot: resolve(options["cbm-root"] ?? defaultCbmRoot),
    codex: options.codex ?? "codex",
    commandTimeoutMs: parseInteger(options["timeout-ms"] ?? 2_700_000, "--timeout-ms", {
      minimum: 100,
    }),
  };
}

function usage() {
  return `Usage:
  node scripts/run-gsc-agent-benchmark.mjs preflight \\
    --suite evaluation/zpam3-v1.json --corpus /path/to/zpam3 \\
    --cbm-root /path/to/codebase-memory-mcp

  node scripts/run-gsc-agent-benchmark.mjs run \\
    --suite evaluation/zpam3-v1.json --corpus /path/to/zpam3 \\
    --cbm-root /path/to/codebase-memory-mcp \\
    --model gpt-5.6-sol --reasoning-effort xhigh \\
    --repetitions 5 --seed zpam3-v1-sol56-xhigh \\
    [--hybrid-only] [--dry-run] [--smoke-only]

  node scripts/run-gsc-agent-benchmark.mjs run --resume \\
    --cohort-dir evaluation/results/zpam3/<cohort-id> \\
    --corpus /path/to/zpam3 --cbm-root /path/to/codebase-memory-mcp \\
    --model gpt-5.6-sol --reasoning-effort xhigh \\
    --repetitions 5 --seed zpam3-v1-sol56-xhigh

  node scripts/run-gsc-agent-benchmark.mjs summarize \\
    evaluation/results/zpam3/<cohort-id> [--suite evaluation/zpam3-v1.json]

Commands:
  preflight   Run all no-spend gates in a temporary isolated cache.
  run         Create or resume a cohort. --dry-run never launches Codex.
              --hybrid-only schedules only hybrid runs and never launches explorer.
  summarize   Rebuild aggregate.json and report.md from finalized attempts.

Safety:
  Source is always mounted read-only to Codex. Raw results and caches remain under
  evaluation/results/, which is ignored by Git. A smoke-only cohort can be inspected
  and continued only when controller, suite, schema, prompt, binary, and source hashes match.`;
}

export async function spawnProcess(
  command,
  args,
  {
    cwd = repoRoot,
    env = process.env,
    input = null,
    timeoutMs = 0,
    killGraceMs = 5_000,
    stdoutPath = null,
    stderrPath = null,
  } = {},
) {
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let forced = false;
  let spawnError = null;
  let timeoutHandle = null;
  let forceHandle = null;
  const stdoutStream = stdoutPath ? createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 }) : null;
  const stderrStream = stderrPath ? createWriteStream(stderrPath, { flags: "wx", mode: 0o600 }) : null;

  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChild = child;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stdoutStream?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      stderrStream?.write(chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceHandle = setTimeout(() => {
          forced = true;
          child.kill("SIGKILL");
        }, killGraceMs);
      }, timeoutMs);
    }

    child.on("close", async (code, signal) => {
      clearTimeout(timeoutHandle);
      clearTimeout(forceHandle);
      if (activeChild === child) {
        activeChild = null;
      }
      stdoutStream?.end();
      stderrStream?.end();
      await Promise.all(
        [stdoutStream, stderrStream].filter(Boolean).map((stream) => finished(stream).catch(() => {})),
      );
      resolvePromise({
        command,
        args: [...args],
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        forced,
        spawnError: spawnError?.message ?? null,
        started_at: new Date(started).toISOString(),
        ended_at: new Date().toISOString(),
        wall_ms: Date.now() - started,
      });
    });

    if (input !== null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function installSignalHandlers() {
  const handler = (signal) => {
    if (!requestedSignal) {
      requestedSignal = signal;
    }
    activeChild?.kill("SIGTERM");
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

async function checked(command, args, options = {}) {
  const result = await spawnProcess(command, args, options);
  expect(!result.spawnError, `${basename(command)} could not start: ${result.spawnError}`);
  expect(!result.timedOut, `${basename(command)} timed out after ${result.wall_ms} ms`);
  expect(
    result.code === 0,
    `${basename(command)} exited ${result.code}${result.signal ? ` (${result.signal})` : ""}: ${result.stderr
      .trim()
      .slice(-2000)}`,
  );
  return result;
}

function readJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

async function readJson(path) {
  return readJsonText(await readFile(path, "utf8"), path);
}

function exactObjectKeys(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${label} keys must be exactly ${wanted.join(", ")}`);
  }
}

function validateObservationShape(actual, expected, label, errors) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      errors.push(`${label} must be an array`);
      return;
    }
    if (expected.length) {
      actual.forEach((item, index) =>
        validateObservationShape(item, expected[0], `${label}[${index}]`, errors)
      );
    }
    return;
  }
  if (expected && typeof expected === "object") {
    exactObjectKeys(actual, Object.keys(expected), label, errors);
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return;
    for (const [key, expectedValue] of Object.entries(expected)) {
      validateObservationShape(actual[key], expectedValue, `${label}.${key}`, errors);
    }
    return;
  }
  const expectedType = typeof expected;
  if (
    typeof actual !== expectedType ||
    (expectedType === "number" && (!Number.isFinite(actual) || !Number.isInteger(actual)))
  ) {
    errors.push(`${label} must be a ${expectedType === "number" ? "finite integer" : expectedType}`);
  }
}

export function validateFinalResponse(run, suite, expected) {
  const errors = [];
  exactObjectKeys(
    run,
    [
      "schema_version",
      "suite_id",
      "run_id",
      "condition",
      "model",
      "repository_revision",
      "metrics",
      "answers",
    ],
    "run",
    errors,
  );
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    return errors;
  }
  if (run.schema_version !== 1) errors.push("schema_version must be 1");
  if (run.suite_id !== suite.suite_id) errors.push(`suite_id must be ${suite.suite_id}`);
  if (run.run_id !== expected.run_id) errors.push(`run_id must be ${expected.run_id}`);
  if (run.condition !== expected.condition) errors.push(`condition must be ${expected.condition}`);
  if (run.model !== expected.model) errors.push(`model must be ${expected.model}`);
  if (run.repository_revision !== expected.repository_revision) {
    errors.push(`repository_revision must be ${expected.repository_revision}`);
  }
  exactObjectKeys(run.metrics, ["wall_ms", "input_tokens", "output_tokens"], "metrics", errors);
  for (const field of ["wall_ms", "input_tokens", "output_tokens"]) {
    if (!Number.isFinite(run.metrics?.[field]) || run.metrics[field] < 0) {
      errors.push(`metrics.${field} must be a non-negative number`);
    }
  }

  const expectedIds = suite.tasks.map((task) => task.id);
  if (Array.isArray(run.answers)) {
    errors.push("answers must be an object keyed by task ID");
    const actualIds = run.answers.map((answer) => answer?.task_id);
    for (const id of expectedIds) {
      const count = actualIds.filter((actual) => actual === id).length;
      if (count !== 1) errors.push(`answers must contain ${id} exactly once (found ${count})`);
    }
    for (const id of actualIds) {
      if (!expectedIds.includes(id)) errors.push(`unexpected task_id: ${String(id)}`);
    }
    return errors;
  }
  if (!run.answers || typeof run.answers !== "object") {
    errors.push("answers must be an object keyed by task ID");
    return errors;
  }
  const actualIds = Object.keys(run.answers);
  for (const id of expectedIds) {
    const count = actualIds.filter((actual) => actual === id).length;
    if (count !== 1) errors.push(`answers must contain ${id} exactly once (found ${count})`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected task_id: ${String(id)}`);
  }
  const tasksById = new Map(suite.tasks.map((task) => [task.id, task]));
  Object.entries(run.answers).forEach(([taskId, answer]) => {
    const label = `answers.${taskId}`;
    exactObjectKeys(answer, ["answer", "files", "observations", "tool_calls"], label, errors);
    if (!answer || typeof answer !== "object") return;
    if (typeof answer.answer !== "string") errors.push(`${label}.answer must be a string`);
    if (!Array.isArray(answer.files) || answer.files.some((item) => typeof item !== "string")) {
      errors.push(`${label}.files must be an array of strings`);
    }
    if (
      !answer.observations ||
      typeof answer.observations !== "object" ||
      Array.isArray(answer.observations)
    ) {
      errors.push(`${label}.observations must be an object`);
    } else if (tasksById.has(taskId)) {
      validateObservationShape(
        answer.observations,
        tasksById.get(taskId).oracle.observations,
        `${label}.observations`,
        errors,
      );
    }
    if (
      !Array.isArray(answer.tool_calls) ||
      answer.tool_calls.some((item) => typeof item !== "string" || !item.trim())
    ) {
      errors.push(`${label}.tool_calls must be an array of non-empty strings`);
    }
  });
  return errors;
}

function canonicalToolName(value) {
  const raw = String(value ?? "")
    .trim()
    .split(/__|\./)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase();
  const aliases = {
    command_execution: "exec_command",
    exec: "exec_command",
    read: "read_file",
    trace_call_path: "trace_path",
  };
  return aliases[raw] ?? raw ?? "";
}

function redactString(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/gi, "$1<redacted>")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "<redacted-api-key>");
}

function redact(value, key = "") {
  if (/token|secret|password|cookie|authorization|api[_-]?key|credential/i.test(key)) {
    return "<redacted>";
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  return typeof value === "string" ? redactString(value) : value;
}

export function parseJsonl(text) {
  const events = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, message: error.message, text: line.slice(0, 300) });
    }
  });
  return { events, errors };
}

function eventTool(item) {
  const type = String(item?.type ?? "").toLowerCase();
  if (type === "mcp_tool_call" || type.includes("mcp")) {
    return {
      name: item.tool ?? item.name ?? item.tool_name,
      namespace: item.server ?? item.server_name ?? item.namespace ?? "mcp",
      arguments: item.arguments ?? item.args ?? item.input ?? null,
    };
  }
  if (type === "command_execution" || type.includes("command")) {
    return {
      name: "exec_command",
      namespace: "native",
      arguments: { command: item.command ?? item.cmd ?? item.input ?? "" },
    };
  }
  if (type.includes("file_read") || type === "read_file") {
    return {
      name: "read_file",
      namespace: "native",
      arguments: item.arguments ?? item.args ?? { path: item.path ?? "" },
    };
  }
  if (type.includes("web_search")) {
    return {
      name: "web_search",
      namespace: "native",
      arguments: item.arguments ?? item.args ?? item.query ?? null,
    };
  }
  if (type.includes("tool_call")) {
    return {
      name: item.tool ?? item.name ?? item.tool_name ?? type,
      namespace: item.namespace ?? "native",
      arguments: item.arguments ?? item.args ?? item.input ?? null,
    };
  }
  return null;
}

export function extractToolEvents(events) {
  const calls = new Map();
  events.forEach((event, sequence) => {
    const item = event?.item ?? (String(event?.type ?? "").includes("tool") ? event : null);
    const tool = eventTool(item);
    if (!tool) return;
    const id = String(item?.id ?? event?.id ?? `event-${sequence + 1}`);
    const prior = calls.get(id);
    const status =
      item?.status ??
      (item?.exit_code === 0 ? "completed" : item?.exit_code != null ? "failed" : null) ??
      (String(event?.type ?? "").endsWith("completed") ? "completed" : "started");
    const record = {
      id,
      order: prior?.order ?? sequence + 1,
      timestamp: event?.timestamp ?? item?.timestamp ?? null,
      namespace: String(tool.namespace ?? ""),
      actual_name: String(tool.name ?? ""),
      canonical_name: canonicalToolName(tool.name),
      arguments: redact(tool.arguments),
      status,
      exit_code: item?.exit_code ?? prior?.exit_code ?? null,
      error: redact(item?.error ?? prior?.error ?? null),
      task_id: item?.task_id ?? prior?.task_id ?? null,
    };
    calls.set(id, { ...prior, ...record });
  });
  return [...calls.values()].sort((left, right) => left.order - right.order);
}

function hasOraclePath(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return ORACLE_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

export function auditToolEvents({ condition, toolEvents, finalResponse, approvedGraphTools = GRAPH_TOOLS }) {
  const violations = [];
  const allowedGraph = new Set(approvedGraphTools.map(canonicalToolName));
  const neutralGraph = new Set(GRAPH_NEUTRAL_TOOLS.map(canonicalToolName));
  const allowedExplorer = new Set(EXPLORER_TOOLS);
  const actualNames = new Set();
  const graphEvidenceCalls = [];
  const successfulGraphEvidenceCalls = [];
  const graphInfrastructureFailures = [];
  const explorerEvidenceCalls = [];
  const successfulExplorerEvidenceCalls = [];
  const reportedAnswers = Array.isArray(finalResponse?.answers)
    ? finalResponse.answers
    : Object.values(finalResponse?.answers ?? {});
  const reportedNames = new Set(
    reportedAnswers
      .flatMap((answer) => answer.tool_calls ?? [])
      .map(canonicalToolName)
      .filter(Boolean),
  );

  for (const call of toolEvents) {
    const name = canonicalToolName(call.canonical_name);
    actualNames.add(name);
    const namespace = call.namespace.toLowerCase();
    const isGraphNamespace =
      /codebase.?memory|codebase_memory|cbm/.test(namespace) || allowedGraph.has(name);
    const usesGraph = condition === "graph" || condition === "hybrid";
    if (usesGraph && allowedGraph.has(name) && !neutralGraph.has(name)) {
      graphEvidenceCalls.push(call);
      if (call.status === "completed" && !call.error) {
        successfulGraphEvidenceCalls.push(call);
      } else if (
        /user cancelled|approval|timed out|timeout|transport|connection (?:closed|reset)|server unavailable/i.test(
          JSON.stringify(call.error ?? ""),
        )
      ) {
        graphInfrastructureFailures.push(call);
      }
    }
    if ((condition === "explorer" || condition === "hybrid") && allowedExplorer.has(name)) {
      explorerEvidenceCalls.push(call);
      if (call.status === "completed" && !call.error && (call.exit_code == null || call.exit_code === 0)) {
        successfulExplorerEvidenceCalls.push(call);
      }
    }
    if (condition === "graph") {
      if ((!allowedGraph.has(name) || !isGraphNamespace) && !neutralGraph.has(name)) {
        violations.push({
          kind: "forbidden_tool",
          tool: name,
          detail: "graph condition permits only the read-only graph allowlist",
        });
      }
    } else if (condition === "explorer" && isGraphNamespace) {
      violations.push({
        kind: "forbidden_tool",
        tool: name,
        detail: "explorer condition cannot use codebase-memory graph tools",
      });
    } else if (condition === "explorer" && !allowedExplorer.has(name)) {
      violations.push({
        kind: "unexpected_tool",
        tool: name,
        detail: "tool namespace was not approved by preflight",
      });
    } else if (
      condition === "hybrid" &&
      !(
        (isGraphNamespace && (allowedGraph.has(name) || neutralGraph.has(name))) ||
        (!isGraphNamespace && allowedExplorer.has(name))
      )
    ) {
      violations.push({
        kind: "unexpected_tool",
        tool: name,
        detail: "hybrid condition permits only the graph allowlist and ordinary explorer tools",
      });
    }
    if (hasOraclePath(call.arguments)) {
      violations.push({
        kind: "oracle_access",
        tool: name,
        detail: "tool arguments reference an oracle-bearing benchmark path",
      });
    }
  }

  if ((condition === "graph" || condition === "hybrid") && graphEvidenceCalls.length === 0) {
    violations.push({
      kind: "missing_graph_evidence",
      detail: "graph condition made no evidence-bearing graph tool call",
    });
  } else if (
    (condition === "graph" || condition === "hybrid") &&
    successfulGraphEvidenceCalls.length === 0
  ) {
    violations.push({
      kind: "no_successful_graph_evidence",
      attempted: graphEvidenceCalls.length,
      detail: "graph condition completed without a successful evidence-bearing graph tool call",
    });
  }
  if ((condition === "graph" || condition === "hybrid") && graphInfrastructureFailures.length > 0) {
    violations.push({
      kind: "graph_tool_infrastructure_failure",
      failed: graphInfrastructureFailures.length,
      tools: [...new Set(graphInfrastructureFailures.map((call) => call.canonical_name))].sort(),
      detail: "graph evidence calls were cancelled or failed at the transport/approval layer",
    });
  }
  if (condition === "hybrid" && explorerEvidenceCalls.length === 0) {
    violations.push({
      kind: "missing_explorer_evidence",
      detail: "hybrid condition made no ordinary explorer tool call",
    });
  } else if (condition === "hybrid" && successfulExplorerEvidenceCalls.length === 0) {
    violations.push({
      kind: "no_successful_explorer_evidence",
      attempted: explorerEvidenceCalls.length,
      detail: "hybrid condition completed without a successful ordinary explorer tool call",
    });
  }

  const omitted = [...actualNames].filter((name) => !reportedNames.has(name)).sort();
  const overreported = [...reportedNames].filter((name) => !actualNames.has(name)).sort();
  if (omitted.length || overreported.length) {
    violations.push({
      kind: "tool_report_mismatch",
      omitted,
      overreported,
      detail: "controller-observed and self-reported tool sets differ",
    });
  }

  return {
    valid: violations.length === 0,
    approved_graph_tools: [...approvedGraphTools],
    actual_calls: toolEvents,
    actual_tool_names: [...actualNames].sort(),
    graph_evidence_calls: graphEvidenceCalls.length,
    successful_graph_evidence_calls: successfulGraphEvidenceCalls.length,
    explorer_evidence_calls: explorerEvidenceCalls.length,
    successful_explorer_evidence_calls: successfulExplorerEvidenceCalls.length,
    self_reported_tool_names: [...reportedNames].sort(),
    infrastructure_failure: graphInfrastructureFailures.length > 0,
    violations,
  };
}

export function parseUsage(events) {
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  for (const event of events) {
    const usage = event?.usage ?? event?.response?.usage ?? null;
    if (!usage || typeof usage !== "object") continue;
    for (const key of Object.keys(totals)) {
      if (Number.isFinite(Number(usage[key]))) totals[key] = Number(usage[key]);
    }
  }
  if (!totals.total_tokens) {
    totals.total_tokens = totals.input_tokens + totals.output_tokens;
  }
  return totals;
}

const UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS = new Set([
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

function validateStructuredOutputSubset(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateStructuredOutputSubset(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    expect(
      !UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS.has(key),
      `${path}.${key} is not supported by the Structured Outputs subset`,
    );
  }
  if (value.type === "object") {
    const properties = Object.keys(value.properties ?? {}).sort();
    const required = [...(value.required ?? [])].sort();
    expect(value.additionalProperties === false, `${path} must set additionalProperties=false`);
    expect(
      JSON.stringify(properties) === JSON.stringify(required),
      `${path} must require every declared property`,
    );
  }
  for (const [key, item] of Object.entries(value)) {
    validateStructuredOutputSubset(item, `${path}.${key}`);
  }
}

function validateSuiteAndSchema(suite, schema) {
  expect(suite?.schema_version === 1, "suite schema_version must be 1");
  expect(suite.suite_id === "zpam3-gsc-agent-benchmark-v1", "unexpected zPAM3 suite_id");
  expect(Array.isArray(suite.tasks) && suite.tasks.length === 20, "zPAM3 suite must contain 20 tasks");
  const ids = suite.tasks.map((task) => task.id);
  expect(new Set(ids).size === ids.length, "suite task IDs must be unique");
  for (const dimension of ["D1", "D2", "D3", "D4", "D5"]) {
    expect(
      suite.tasks.filter((task) => task.dimension === dimension).length === 4,
      `${dimension} must contain four tasks`,
    );
  }
  validateStructuredOutputSubset(schema);
  const answerSchema = schema.properties?.answers;
  const schemaIds = Object.keys(answerSchema?.properties ?? {});
  expect(
    JSON.stringify([...schemaIds].sort()) === JSON.stringify([...ids].sort()),
    "agent-run schema task IDs do not match the suite",
  );
  expect(
    JSON.stringify([...(answerSchema?.required ?? [])].sort()) ===
      JSON.stringify([...ids].sort()),
    "agent-run schema must require all 20 task IDs",
  );
  expect(answerSchema?.additionalProperties === false, "answers must reject unknown task IDs");
  for (const id of ids) {
    const reference = answerSchema.properties?.[id]?.$ref;
    expect(
      reference === `#/$defs/answer-${id}` && schema.$defs?.[`answer-${id}`],
      `schema must define an exact answer for ${id}`,
    );
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function codexConfig({
  condition,
  model,
  reasoningEffort,
  cbmBinary,
  cacheDir,
  corpus,
}) {
  const graphEnabled = condition !== "explorer";
  const shellEnabled = condition !== "graph";
  return [
    `model = ${tomlString(model)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "",
    "[features]",
    ...DISABLED_FEATURES.map((feature) => `${feature} = false`),
    `shell_tool = ${shellEnabled}`,
    `unified_exec = ${shellEnabled}`,
    "",
    "[mcp_servers.codebase_memory]",
    `command = ${tomlString(cbmBinary)}`,
    "args = []",
    `enabled = ${graphEnabled}`,
    `required = ${graphEnabled}`,
    `enabled_tools = [${GRAPH_TOOLS.map(tomlString).join(", ")}]`,
    // The allowlist is read-oriented, but codebase-memory conservatively marks
    // graph reads destructive because corrupt-store recovery may quarantine its
    // disposable cache. Pre-approve only this exact allowlist so non-interactive
    // runs do not silently cancel every evidence-bearing call.
    'default_tools_approval_mode = "approve"',
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 120",
    "",
    "[mcp_servers.codebase_memory.env]",
    `CBM_CACHE_DIR = ${tomlString(cacheDir)}`,
    `CBM_ALLOWED_ROOT = ${tomlString(corpus)}`,
    'CBM_LOG_LEVEL = "warn"',
    "",
  ].join("\n");
}

async function createIsolatedCodexHome() {
  const path = await mkdtemp(join(tmpdir(), "gsc-agent-benchmark-codex-"));
  await chmod(path, 0o700);
  const sourceHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const authSource = join(sourceHome, "auth.json");
  const authStat = await stat(authSource).catch(() => null);
  expect(authStat?.isFile(), `Codex authentication not found at ${authSource}`);
  expect((authStat.mode & 0o077) === 0, "Codex auth.json must not be group/world accessible");
  await symlink(authSource, join(path, "auth.json"));
  return {
    path,
    auth_strategy: "owner-only temporary CODEX_HOME with a symlink to the existing mode-0600 auth file",
  };
}

async function writeCodexConfig(codexHome, configuration) {
  await atomicWrite(join(codexHome, "config.toml"), configuration);
}

function codexExecArgv({
  model,
  reasoningEffort,
  corpus,
  schemaPath,
  finalPath,
}) {
  return [
    "exec",
    "--ephemeral",
    "--strict-config",
    "--model",
    model,
    "--config",
    `model_reasoning_effort=${tomlString(reasoningEffort)}`,
    "--config",
    'approval_policy="never"',
    "--sandbox",
    "read-only",
    "--cd",
    corpus,
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    finalPath,
    "--ignore-rules",
    "--color",
    "never",
    "-",
  ];
}

async function repoState(path) {
  const [head, statusResult, branch] = await Promise.all([
    checked("git", ["-C", path, "rev-parse", "HEAD"]),
    checked("git", ["-C", path, "status", "--porcelain=v1", "--branch"]),
    checked("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  return {
    path,
    commit: head.stdout.trim(),
    branch: branch.stdout.trim(),
    status: statusResult.stdout.trim().split(/\r?\n/).filter(Boolean),
    dirty: statusResult.stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("##")),
  };
}

async function listGscFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gsc")) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function corpusFingerprint(root) {
  const files = await listGscFiles(root);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return { file_count: files.length, sha256: hash.digest("hex") };
}

async function verifyCorpus(corpus, suite) {
  const absolute = await realpath(corpus);
  const head = (await checked("git", ["-C", absolute, "rev-parse", "HEAD"])).stdout.trim();
  expect(head === suite.target.revision, `zPAM3 HEAD must be ${suite.target.revision}, got ${head}`);
  const origin = (await checked("git", ["-C", absolute, "remote", "get-url", "origin"])).stdout.trim();
  const normalized = (value) => value.replace(/\/+$/, "").replace(/\.git$/, "");
  expect(
    normalized(origin) === normalized(suite.target.repository),
    `zPAM3 origin must be ${suite.target.repository}, got ${origin}`,
  );
  await copyFile(overlayPath, join(absolute, ".codebase-memory.json"));
  expect(
    (await readFile(overlayPath)).equals(await readFile(join(absolute, ".codebase-memory.json"))),
    "zPAM3 .codebase-memory.json does not match the pinned overlay",
  );
  const status = (
    await checked("git", ["-C", absolute, "status", "--porcelain=v1", "--untracked-files=all"])
  ).stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  expect(
    status.every((line) => /^\?\? \.codebase-memory\.json$/.test(line)),
    `zPAM3 has changes other than the permitted overlay: ${status.join("; ")}`,
  );
  const fingerprint = await corpusFingerprint(absolute);
  expect(fingerprint.file_count === 180, `expected 180 .gsc files, got ${fingerprint.file_count}`);
  return { path: absolute, head, origin, status, fingerprint };
}

function parseCbmJson(stdout, tool) {
  const candidates = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"));
  expect(candidates.length, `${tool} did not emit JSON`);
  const envelope = readJsonText(candidates.at(-1), `${tool} output`);
  expect(!envelope.isError, `${tool} returned an MCP error`);
  if (envelope.structuredContent !== undefined) return envelope.structuredContent;
  const text = envelope.content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? readJsonText(text, `${tool} text result`) : envelope;
}

async function cbmTool(binary, env, tool, argumentsValue, timeoutMs = 300_000) {
  const result = await checked(
    binary,
    ["cli", "--json", tool, JSON.stringify(argumentsValue)],
    { env, timeoutMs },
  );
  return { value: parseCbmJson(result.stdout, tool), process: result };
}

async function graphInvariants({ binary, cacheDir, corpus, suite, index }) {
  const env = {
    ...process.env,
    CBM_CACHE_DIR: cacheDir,
    CBM_ALLOWED_ROOT: corpus,
    CBM_LOG_LEVEL: "warn",
  };
  let indexResult = null;
  if (index) {
    indexResult = await cbmTool(
      binary,
      env,
      "index_repository",
      { repo_path: corpus, name: suite.target.project_name, mode: "full" },
      900_000,
    );
    expect(indexResult.value.status === "indexed", "codebase-memory index did not finish");
  }
  const projects = await cbmTool(binary, env, "list_projects", {});
  const project = projects.value.projects?.find((item) => item.name === suite.target.project_name);
  expect(project, `graph project ${suite.target.project_name} was not found`);
  expect(project.root_path === corpus, `graph project root must be ${corpus}, got ${project.root_path}`);

  const count = await cbmTool(binary, env, "query_graph", {
    project: suite.target.project_name,
    format: "json",
    query: "MATCH (f:Function) RETURN count(f) AS function_count",
  });
  const functionCount = Number(count.value.rows?.[0]?.[0]);
  expect(functionCount === 1580, `expected 1580 Function nodes, got ${functionCount}`);

  const callers = await cbmTool(binary, env, "query_graph", {
    project: suite.target.project_name,
    format: "json",
    query:
      'MATCH (caller:Function)-[:CALLS]->(target:Function) WHERE target.name IN ["generateMatchDescriptionDebounced", "addEventListener"] RETURN target.name AS target, count(DISTINCT caller) AS direct_callers ORDER BY target',
  });
  const callerCounts = Object.fromEntries(
    (callers.value.rows ?? []).map(([name, value]) => [name, Number(value)]),
  );
  expect(
    callerCounts.generateMatchDescriptionDebounced === 6,
    `generateMatchDescriptionDebounced must have 6 callers, got ${callerCounts.generateMatchDescriptionDebounced}`,
  );
  expect(
    callerCounts.addEventListener === 72,
    `addEventListener must have 72 callers, got ${callerCounts.addEventListener}`,
  );

  const d4 = await cbmTool(binary, env, "query_graph", {
    project: suite.target.project_name,
    format: "json",
    query:
      'MATCH (caller:Function)-[c:CALLS]->(target:Function) WHERE caller.name = "main" AND caller.file_path IN ["source/maps/mp/mp_toujane.gsc", "source/maps/mp/_load.gsc", "source/maps/mp/mp_rhine.gsc"] AND c.module_path IS NOT NULL RETURN caller.file_path AS caller_file, c.module_path AS module_path, target.name AS target_name, target.file_path AS target_file, c.threaded AS threaded ORDER BY caller_file, module_path',
  });
  const edgeKeys = new Set(
    (d4.value.rows ?? []).map((row) => JSON.stringify(row.slice(0, 4).map(String))),
  );
  const missingEdges = EXPECTED_D4_EDGES.filter((edge) => !edgeKeys.has(JSON.stringify(edge)));
  expect(!missingEdges.length, `graph is missing D4 startup edges: ${JSON.stringify(missingEdges)}`);

  return {
    project: {
      name: project.name,
      root_path: project.root_path,
      nodes: Number(project.nodes),
      edges: Number(project.edges),
    },
    function_count: functionCount,
    direct_callers: callerCounts,
    d4_path_qualified_edges: EXPECTED_D4_EDGES.map(([caller_file, module_path, target_name, target_file]) => ({
      caller_file,
      module_path,
      target_name,
      target_file,
    })),
    index_duration_ms: indexResult?.process.wall_ms ?? 0,
    index_result: indexResult?.value ?? null,
  };
}

async function promptFor(condition, suitePath) {
  const result = await checked(process.execPath, [
    harnessPath,
    "prompt",
    condition,
    "--suite",
    suitePath,
  ]);
  return result.stdout;
}

function normalizedConditionPrompt(prompt, suite, condition) {
  let normalized = prompt.replace(
    new RegExp(`Condition: ${condition}[^\\n]*`),
    "Condition: <condition>",
  );
  normalized = normalized.replace(
    `"condition": "${condition}"`,
    '"condition": "<condition>"',
  );
  for (const instruction of suite.conditions[condition].instructions) {
    normalized = normalized.replace(`- ${instruction}\n`, "");
  }
  return normalized;
}

function oracleScalars(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => oracleScalars(item, result));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => oracleScalars(item, result));
  } else if (typeof value === "string" && value.length >= 8) {
    result.push(value);
  }
  return result;
}

function auditPromptInput(raw, generatedPrompt, suite, condition) {
  const lower = raw.toLowerCase();
  const violations = [];
  const contamination = [
    "always prefer mcp graph tools over grep",
    "codebase knowledge graph (codebase-memory-mcp)",
    "jump4life",
    "scorer-pass-fixture",
    "evaluation/results/zpam3/",
  ];
  for (const marker of contamination) {
    if (lower.includes(marker.toLowerCase())) violations.push(`model input contains: ${marker}`);
  }
  for (const task of suite.tasks) {
    for (const scalar of oracleScalars(task.oracle)) {
      if (!generatedPrompt.includes(scalar) && raw.includes(scalar)) {
        violations.push(`model input leaks a hidden oracle value for ${task.id}`);
      }
    }
  }
  if (condition === "explorer" && /always prefer.*graph tools/i.test(raw)) {
    violations.push("explorer input contains a global graph preference");
  }
  return [...new Set(violations)];
}

function redactPromptAudit(raw, codexHome) {
  return redactString(raw)
    .replaceAll(codexHome, "<BENCHMARK_CODEX_HOME>")
    .replaceAll(join(homedir(), ".codex", "auth.json"), "<CODEX_AUTH>");
}

function enabledServers(inventory) {
  const entries = Array.isArray(inventory)
    ? inventory
    : Array.isArray(inventory?.servers)
      ? inventory.servers
      : Object.entries(inventory ?? {}).map(([name, value]) => ({ name, ...value }));
  return entries
    .map((entry) => ({
      ...entry,
      name: entry.name ?? entry.id ?? entry.server_name,
      command: entry.command ?? entry.transport?.command,
      args: entry.args ?? entry.transport?.args,
      enabled: entry.enabled !== false && entry.disabled !== true,
    }))
    .filter((entry) => entry.enabled);
}

async function codexEnvironmentAudit({
  codex,
  codexHome,
  cbmBinary,
  cacheDir,
  corpus,
  model,
  reasoningEffort,
  suite,
  suitePath,
  auditDir,
}) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const generated = Object.fromEntries(
    await Promise.all(
      CONDITION_NAMES.map(async (condition) => [condition, await promptFor(condition, suitePath)]),
    ),
  );
  const neutralPrompt = normalizedConditionPrompt(generated.graph, suite, "graph");
  for (const condition of CONDITION_NAMES.slice(1)) {
    expect(
      neutralPrompt === normalizedConditionPrompt(generated[condition], suite, condition),
      `${condition} prompt differs outside the declared condition block`,
    );
  }
  const audits = {};
  for (const condition of CONDITION_NAMES) {
    const configuration = codexConfig({
      condition,
      model,
      reasoningEffort,
      cbmBinary,
      cacheDir,
      corpus,
    });
    const shellToolEnabled = condition !== "graph";
    expect(
      configuration.includes(`shell_tool = ${shellToolEnabled}`) &&
        configuration.includes(`unified_exec = ${shellToolEnabled}`),
      `${condition} shell-tool configuration is inconsistent`,
    );
    await writeCodexConfig(codexHome, configuration);
    const env = { ...process.env, CODEX_HOME: codexHome };
    const promptInput = await checked(
      codex,
      ["debug", "prompt-input", generated[condition]],
      { cwd: corpus, env, timeoutMs: 120_000 },
    );
    readJsonText(promptInput.stdout, `${condition} prompt-input`);
    const promptViolations = auditPromptInput(promptInput.stdout, generated[condition], suite, condition);
    expect(!promptViolations.length, `${condition} prompt audit failed: ${promptViolations.join("; ")}`);

    const inventoryResult = await checked(
      codex,
      ["mcp", "list", "--json"],
      { cwd: corpus, env, timeoutMs: 120_000 },
    );
    const inventory = readJsonText(inventoryResult.stdout, `${condition} MCP inventory`);
    const enabled = enabledServers(inventory);
    if (condition === "graph" || condition === "hybrid") {
      expect(
        enabled.length === 1,
        `${condition} must expose exactly one MCP server, got ${enabled.length}`,
      );
      expect(
        enabled[0].name === "codebase_memory",
        `${condition} MCP server must be codebase_memory`,
      );
      expect(
        resolve(enabled[0].command) === cbmBinary,
        `${condition} MCP command must be ${cbmBinary}, got ${enabled[0].command}`,
      );
    } else {
      expect(enabled.length === 0, `explorer must expose no MCP servers, got ${enabled.length}`);
    }
    const forbiddenInventory = enabled.filter((entry) =>
      /context|openai|web|app|plugin/i.test(String(entry.name)),
    );
    expect(!forbiddenInventory.length, `${condition} exposes unrelated MCP servers`);

    const redactedInput = redactPromptAudit(promptInput.stdout, codexHome);
    await atomicWrite(join(auditDir, `${condition}.prompt-input.json`), redactedInput);
    await atomicWrite(join(auditDir, `${condition}.mcp-inventory.json`), redact(inventory));
    audits[condition] = {
      prompt_input_sha256: sha256(promptInput.stdout),
      redacted_prompt_input_sha256: sha256(redactedInput),
      generated_prompt_sha256: sha256(generated[condition]),
      mcp_inventory_sha256: sha256(inventoryResult.stdout),
      enabled_mcp_servers: enabled.map((entry) => entry.name),
      shell_tool_enabled: shellToolEnabled,
      files: {
        prompt_input: relative(auditDir, join(auditDir, `${condition}.prompt-input.json`)),
        mcp_inventory: relative(auditDir, join(auditDir, `${condition}.mcp-inventory.json`)),
      },
    };
  }
  return {
    conditions: audits,
    neutral_prompt_sha256: sha256(neutralPrompt),
  };
}

async function controllerHash(suitePath, schemaPath) {
  const hash = createHash("sha256");
  for (const path of [runnerPath, harnessPath, suitePath, schemaPath, overlayPath]) {
    hash.update(relative(repoRoot, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function runNoSpendGates({ corpus, cbmRoot }) {
  const commands = [
    ["mise", ["run", "eval:check"], {}],
    ["mise", ["run", "test:zpam3"], { ZPAM3_ROOT: corpus }],
    ["mise", ["run", "test:codebase-memory"], { CBM_ROOT: cbmRoot }],
    ["mise", ["run", "vendor:check"], { CBM_ROOT: cbmRoot }],
  ];
  const results = [];
  for (const [command, args, extraEnv] of commands) {
    const result = await checked(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      timeoutMs: 900_000,
    });
    results.push({
      command: [command, ...args],
      wall_ms: result.wall_ms,
      stdout_tail: result.stdout.trim().split(/\r?\n/).slice(-8),
    });
  }
  return results;
}

async function performPreflight({
  common,
  cacheDir,
  auditDir,
  model,
  reasoningEffort,
  reuseCache = false,
  runGates = true,
}) {
  expect(common.corpus, "--corpus is required");
  const suite = await readJson(common.suitePath);
  const schema = await readJson(common.schemaPath);
  validateSuiteAndSchema(suite, schema);
  const corpus = await verifyCorpus(common.corpus, suite);
  const treeSitterState = await repoState(repoRoot);
  const cbmState = await repoState(common.cbmRoot);
  const cbmBinary = resolve(common.cbmRoot, "build", "c", "codebase-memory-mcp");
  if (!reuseCache) {
    await checked("make", ["-f", "Makefile.cbm", "cbm"], {
      cwd: common.cbmRoot,
      timeoutMs: 900_000,
    });
  }
  const binaryStat = await stat(cbmBinary).catch(() => null);
  expect(binaryStat?.isFile(), `local codebase-memory binary not found: ${cbmBinary}`);

  const codexVersion = await checked(common.codex, ["--version"]);
  const loginStatus = await checked(common.codex, ["login", "status"]);
  expect(/logged in/i.test(loginStatus.stdout + loginStatus.stderr), "Codex is not logged in");
  const execHelp = await checked(common.codex, ["exec", "--help"]);
  for (const flag of REQUIRED_EXEC_FLAGS) {
    expect(execHelp.stdout.includes(flag), `installed Codex is missing required exec flag ${flag}`);
  }
  const promptHelp = await checked(common.codex, ["debug", "prompt-input", "--help"]);
  expect(/model-visible prompt input/i.test(promptHelp.stdout), "codex debug prompt-input is unavailable");
  const mcpHelp = await checked(common.codex, ["mcp", "list", "--help"]);
  expect(mcpHelp.stdout.includes("--json"), "codex mcp list --json is unavailable");

  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const invariants = await graphInvariants({
    binary: cbmBinary,
    cacheDir,
    corpus: corpus.path,
    suite,
    index: !reuseCache,
  });
  const codexHome = await createIsolatedCodexHome();
  let promptAudit;
  try {
    promptAudit = await codexEnvironmentAudit({
      codex: common.codex,
      codexHome: codexHome.path,
      cbmBinary,
      cacheDir,
      corpus: corpus.path,
      model,
      reasoningEffort,
      suite,
      suitePath: common.suitePath,
      auditDir,
    });
  } catch (error) {
    await rm(codexHome.path, { recursive: true, force: true });
    throw error;
  }
  const gates = runGates ? await runNoSpendGates({ corpus: corpus.path, cbmRoot: common.cbmRoot }) : [];
  return {
    suite,
    schema,
    codexHome,
    facts: {
      schema_version: 1,
      completed_at: new Date().toISOString(),
      codex_cli_version: codexVersion.stdout.trim(),
      codex_login: loginStatus.stdout.trim() || loginStatus.stderr.trim(),
      tree_sitter_gsc: treeSitterState,
      codebase_memory: cbmState,
      source: corpus,
      binary: {
        path: cbmBinary,
        sha256: await sha256File(cbmBinary),
      },
      graph: {
        cache_dir: cacheDir,
        cache_identity: sha256(`${cacheDir}\0${suite.target.project_name}`).slice(0, 24),
        ...invariants,
      },
      prompt_audit: promptAudit,
      suite_sha256: await sha256File(common.suitePath),
      output_schema_sha256: await sha256File(common.schemaPath),
      controller_sha256: await controllerHash(common.suitePath, common.schemaPath),
      no_spend_gates: gates,
      environment: {
        platform: platform(),
        node: process.version,
        sandbox: "read-only",
        approval_policy: "never",
        sessions: "ephemeral",
        disabled_features: DISABLED_FEATURES,
        auth_strategy: codexHome.auth_strategy,
      },
    },
  };
}

function appendControllerMetadata(prompt, expected, reasoningEffort) {
  return `${prompt.trimEnd()}

Controller-owned run metadata (copy these exact values into the JSON object):
- run_id: ${expected.run_id}
- condition: ${expected.condition}
- model: ${expected.model}
- reasoning_effort: ${reasoningEffort}
- repository_revision: ${expected.repository_revision}

The controller will reject, not rewrite, a mismatched run_id, condition, model, or repository_revision.
`;
}

function attemptName(number, condition) {
  return `${String(number).padStart(3, "0")}-${condition}`;
}

export function infrastructureFailure(processResult, jsonlErrors) {
  if (processResult.spawnError) return true;
  if (processResult.timedOut) return false;
  const text = `${processResult.stderr}\n${processResult.stdout}`;
  if (/invalid_json_schema|response_format/i.test(text)) return false;
  if (
    processResult.code !== 0 &&
    /(authentication|unauthorized|service unavailable|temporarily unavailable|connection reset|rate limit|(?:http|status|error)[^\n]{0,24}\b(?:429|5\d\d)\b)/i.test(
      text,
    )
  ) {
    return true;
  }
  return processResult.code !== 0 && jsonlErrors.length > 0;
}

export function shouldRetryAttempt(attempt, infrastructureRetries, maxInfrastructureRetries) {
  return attempt.infrastructure_failure && infrastructureRetries < maxInfrastructureRetries;
}

async function scoreRun(runPath, suitePath) {
  const result = await spawnProcess(process.execPath, [
    harnessPath,
    "score",
    runPath,
    "--suite",
    suitePath,
  ]);
  if (result.code !== 0 || result.spawnError) {
    return { value: null, error: result.stderr.trim() || result.spawnError || `exit ${result.code}` };
  }
  try {
    return { value: JSON.parse(result.stdout), error: null };
  } catch (error) {
    return { value: null, error: `scorer emitted malformed JSON: ${error.message}` };
  }
}

async function executeAttempt({
  number,
  condition,
  pair,
  tryNumber,
  cohortDir,
  common,
  suite,
  preflight,
  model,
  reasoningEffort,
  timeoutMs,
  killGraceMs,
}) {
  const name = attemptName(number, condition);
  const temporaryDir = join(
    cohortDir,
    "attempts",
    `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const finalDir = join(cohortDir, "attempts", name);
  await mkdir(temporaryDir, { recursive: true, mode: 0o700 });
  expect(
    !(await lstat(finalDir).catch(() => null)),
    `attempt artifact already exists and will not be overwritten: ${finalDir}`,
  );

  const runId = `${basename(cohortDir)}-${name}`;
  const expected = {
    run_id: runId,
    condition,
    model,
    repository_revision: suite.target.revision,
  };
  const basePrompt = await promptFor(condition, common.suitePath);
  const prompt = appendControllerMetadata(basePrompt, expected, reasoningEffort);
  const promptPath = join(temporaryDir, "prompt.txt");
  const eventsPath = join(temporaryDir, "events.jsonl");
  const stderrPath = join(temporaryDir, "stderr.txt");
  const finalPath = join(temporaryDir, "final.json");
  const runPath = join(temporaryDir, "run.json");
  await atomicWrite(promptPath, prompt);

  const configuration = codexConfig({
    condition,
    model,
    reasoningEffort,
    cbmBinary: preflight.binary.path,
    cacheDir: preflight.graph.cache_dir,
    corpus: preflight.source.path,
  });
  await writeCodexConfig(preflight.codex_home, configuration);
  const argv = codexExecArgv({
    model,
    reasoningEffort,
    corpus: preflight.source.path,
    schemaPath: common.schemaPath,
    finalPath,
  });
  const before = await corpusFingerprint(preflight.source.path);
  const initialMetadata = {
    schema_version: 1,
    run_id: runId,
    attempt_number: number,
    pair,
    condition,
    try: tryNumber,
    requested_model: model,
    requested_reasoning_effort: reasoningEffort,
    repository_revision: suite.target.revision,
    codex_cli_version: preflight.codex_cli_version,
    argv: [common.codex, ...argv],
    cwd: preflight.source.path,
    corpus_before: before,
    status: "running",
  };
  await atomicWrite(join(temporaryDir, "metadata.json"), initialMetadata);

  const processResult = await spawnProcess(common.codex, argv, {
    cwd: preflight.source.path,
    env: { ...process.env, CODEX_HOME: preflight.codex_home },
    input: prompt,
    timeoutMs,
    killGraceMs,
    stdoutPath: eventsPath,
    stderrPath,
  });
  const after = await corpusFingerprint(preflight.source.path);
  const parsedEvents = parseJsonl(processResult.stdout);
  const toolEvents = extractToolEvents(parsedEvents.events);
  const usage = parseUsage(parsedEvents.events);
  const reasons = [];
  if (processResult.spawnError) reasons.push(`process launch failed: ${processResult.spawnError}`);
  if (processResult.timedOut) reasons.push(`timeout after ${processResult.wall_ms} ms`);
  if (processResult.code !== 0) reasons.push(`Codex exited ${processResult.code}`);
  if (processResult.signal) reasons.push(`Codex terminated by ${processResult.signal}`);
  if (parsedEvents.errors.length) reasons.push(`malformed JSONL events: ${parsedEvents.errors.length}`);
  if (before.sha256 !== after.sha256 || before.file_count !== after.file_count) {
    reasons.push("source corpus changed during the attempt");
  }

  let finalText = null;
  let finalResponse = null;
  try {
    finalText = await readFile(finalPath, "utf8");
    finalResponse = JSON.parse(finalText);
  } catch (error) {
    reasons.push(`malformed or missing final JSON: ${error.message}`);
    if (finalText === null) await atomicWrite(finalPath, "null\n");
  }

  let validationErrors = [];
  if (finalResponse) {
    validationErrors = validateFinalResponse(finalResponse, suite, expected);
    reasons.push(...validationErrors.map((error) => `response schema: ${error}`));
  }
  const toolAudit = auditToolEvents({
    condition,
    toolEvents,
    finalResponse,
  });
  reasons.push(
    ...toolAudit.violations.map((violation) => `tool audit: ${violation.kind} (${violation.tool ?? ""})`),
  );

  let controllerRun = null;
  let score = { value: null, error: null };
  if (finalResponse && validationErrors.length === 0) {
    controllerRun = {
      ...finalResponse,
      metrics: {
        wall_ms: processResult.wall_ms,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    };
    await atomicWrite(runPath, controllerRun);
    score = await scoreRun(runPath, common.suitePath);
    if (score.error) reasons.push(`scoring failed: ${score.error}`);
  } else {
    await atomicWrite(runPath, null);
  }
  await atomicWrite(join(temporaryDir, "tool-audit.json"), toolAudit);
  await atomicWrite(join(temporaryDir, "score.json"), score.value);

  const uniqueReasons = [...new Set(reasons)];
  const metadata = {
    ...initialMetadata,
    status: uniqueReasons.length === 0 ? "valid" : "invalid",
    valid: uniqueReasons.length === 0,
    invalidation_reasons: uniqueReasons,
    infrastructure_failure:
      infrastructureFailure(processResult, parsedEvents.errors) || toolAudit.infrastructure_failure,
    process: {
      started_at: processResult.started_at,
      ended_at: processResult.ended_at,
      wall_ms: processResult.wall_ms,
      exit_code: processResult.code,
      signal: processResult.signal,
      timed_out: processResult.timedOut,
      forced_termination: processResult.forced,
      spawn_error: processResult.spawnError,
    },
    usage,
    jsonl_parse_errors: parsedEvents.errors,
    corpus_after: after,
    final_response_sha256: finalText === null ? null : sha256(finalText),
    score_quality: score.value?.quality ?? null,
  };
  await atomicWrite(join(temporaryDir, "metadata.json"), metadata);
  await rename(temporaryDir, finalDir);
  return {
    name,
    path: relative(cohortDir, finalDir),
    run_id: runId,
    pair,
    condition,
    try: tryNumber,
    valid: metadata.valid,
    status: metadata.status,
    infrastructure_failure: metadata.infrastructure_failure,
    invalidation_reasons: uniqueReasons,
    score_quality: metadata.score_quality,
    wall_ms: processResult.wall_ms,
    finalized_at: new Date().toISOString(),
  };
}

function cohortId(seed) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeSeed = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `${timestamp}-${safeSeed}-${randomBytes(4).toString("hex")}`;
}

export function scheduleFor(repetitions, { hybridOnly = false } = {}) {
  const source = hybridOnly ? HYBRID_SCHEDULE : SCHEDULE;
  expect(
    repetitions <= source.length,
    `at most ${source.length} ${hybridOnly ? "hybrid" : "paired"} repetitions are supported`,
  );
  return source.slice(0, repetitions).map((conditions, index) => ({
    pair: index + 1,
    conditions,
  }));
}

function manifestImmutable(manifest) {
  return {
    suite_path: manifest.suite_path,
    suite_sha256: manifest.suite_sha256,
    output_schema_path: manifest.output_schema_path,
    output_schema_sha256: manifest.output_schema_sha256,
    controller_sha256: manifest.controller_sha256,
    corpus: manifest.source.path,
    source_revision: manifest.source.head,
    cbm_binary: manifest.binary.path,
    cbm_binary_sha256: manifest.binary.sha256,
    model: manifest.requested_model,
    reasoning_effort: manifest.requested_reasoning_effort,
    repetitions: manifest.repetitions,
    seed: manifest.seed,
    run_mode: manifest.run_mode ?? "paired",
    neutral_prompt_sha256: manifest.prompt_audit.neutral_prompt_sha256,
  };
}

async function initializeManifest({
  cohortDir,
  common,
  preflight,
  model,
  reasoningEffort,
  repetitions,
  seed,
  hybridOnly,
}) {
  const manifest = {
    schema_version: 1,
    cohort_id: basename(cohortDir),
    created_at: new Date().toISOString(),
    status: "preflighted",
    suite_path: common.suitePath,
    suite_sha256: preflight.facts.suite_sha256,
    output_schema_path: common.schemaPath,
    output_schema_sha256: preflight.facts.output_schema_sha256,
    controller_sha256: preflight.facts.controller_sha256,
    schedule: scheduleFor(repetitions, { hybridOnly }),
    run_mode: hybridOnly ? "hybrid-only" : "paired",
    seed,
    repetitions,
    requested_model: model,
    requested_reasoning_effort: reasoningEffort,
    codex_cli_version: preflight.facts.codex_cli_version,
    source_repository_url: preflight.suite.target.repository,
    source: preflight.facts.source,
    tree_sitter_gsc: preflight.facts.tree_sitter_gsc,
    codebase_memory: preflight.facts.codebase_memory,
    binary: preflight.facts.binary,
    graph: {
      ...preflight.facts.graph,
      cache_artifact: "cbm-cache",
    },
    prompt_audit: preflight.facts.prompt_audit,
    environment: preflight.facts.environment,
    no_spend_gates: preflight.facts.no_spend_gates,
    attempts: [],
  };
  await atomicWrite(join(cohortDir, "manifest.json"), manifest);
  return manifest;
}

async function assertResumeCompatible(manifest, preflight, options) {
  const current = {
    suite_path: options.common.suitePath,
    suite_sha256: preflight.facts.suite_sha256,
    output_schema_path: options.common.schemaPath,
    output_schema_sha256: preflight.facts.output_schema_sha256,
    controller_sha256: preflight.facts.controller_sha256,
    corpus: preflight.facts.source.path,
    source_revision: preflight.facts.source.head,
    cbm_binary: preflight.facts.binary.path,
    cbm_binary_sha256: preflight.facts.binary.sha256,
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    repetitions: options.repetitions,
    seed: options.seed,
    run_mode: options.hybridOnly ? "hybrid-only" : "paired",
    neutral_prompt_sha256: preflight.facts.prompt_audit.neutral_prompt_sha256,
  };
  const pinned = manifestImmutable(manifest);
  expect(
    JSON.stringify(current) === JSON.stringify(pinned),
    `cohort cannot resume because immutable inputs changed\nexpected: ${JSON.stringify(
      pinned,
      null,
      2,
    )}\nactual: ${JSON.stringify(current, null, 2)}`,
  );
}

function dryRunPlan({ common, preflight, manifest, model, reasoningEffort, cohortDir }) {
  const conditions = [...new Set(manifest.schedule.flatMap((entry) => entry.conditions))];
  return {
    no_model_calls: true,
    cohort_dir: cohortDir,
    schedule: manifest.schedule,
    conditions: Object.fromEntries(
      conditions.map((condition) => {
        const finalPath = join(
          cohortDir,
          "attempts",
          `<attempt>-${condition}`,
          "final.json",
        );
        return [
          condition,
          {
            codex_argv: [
              common.codex,
              ...codexExecArgv({
                model,
                reasoningEffort,
                corpus: preflight.facts.source.path,
                schemaPath: common.schemaPath,
                finalPath,
              }),
            ],
            enabled_mcp_servers:
              preflight.facts.prompt_audit.conditions[condition].enabled_mcp_servers,
            generated_prompt_sha256:
              preflight.facts.prompt_audit.conditions[condition].generated_prompt_sha256,
          },
        ];
      }),
    ),
    invariants: {
      source_revision: preflight.facts.source.head,
      model,
      reasoning_effort: reasoningEffort,
      sandbox: "read-only",
      ephemeral: true,
      function_count: preflight.facts.graph.function_count,
      direct_callers: preflight.facts.graph.direct_callers,
      d4_path_qualified_edges: preflight.facts.graph.d4_path_qualified_edges.length,
    },
  };
}

function numberSummary(values) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return { count: 0, mean: null, median: null, min: null, max: null, p95: null };
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const middle = Math.floor(numbers.length / 2);
  const median =
    numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
  return {
    count: numbers.length,
    mean,
    median,
    min: numbers[0],
    max: numbers.at(-1),
    p95: numbers[Math.max(0, Math.ceil(numbers.length * 0.95) - 1)],
  };
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function likelyFailureMode(taskScore) {
  const failed = taskScore.checks.filter((check) => !check.passed).map((check) => check.name);
  if (failed.some((name) => name.startsWith("file:"))) return "agent lookup/evidence failure";
  if (failed.some((name) => name.startsWith("observation:"))) {
    return "agent reasoning, graph lookup ambiguity, or ordinary model variance";
  }
  return "incorrectly formatted answer";
}

export async function summarizeCohort(cohortDir, suitePath = defaultSuitePath) {
  const absolute = resolve(cohortDir);
  const manifest = await readJson(join(absolute, "manifest.json"));
  const suite = await readJson(resolve(suitePath));
  const attempts = [];
  for (const entry of manifest.attempts) {
    const directory = resolve(absolute, entry.path);
    const metadata = await readJson(join(directory, "metadata.json"));
    const audit = await readJson(join(directory, "tool-audit.json"));
    const score = await readJson(join(directory, "score.json"));
    attempts.push({ entry, directory, metadata, audit, score });
  }
  const aggregate = {
    schema_version: 1,
    cohort_id: manifest.cohort_id,
    generated_at: new Date().toISOString(),
    status: manifest.status,
    suite_id: suite.suite_id,
    conditions: {},
    paired_differences: [],
    invalid_attempts: attempts
      .filter((attempt) => !attempt.entry.valid)
      .map((attempt) => ({
        run_id: attempt.entry.run_id,
        condition: attempt.entry.condition,
        reasons: attempt.entry.invalidation_reasons,
      })),
    structured_output_failures: attempts.filter((attempt) =>
      attempt.entry.invalidation_reasons.some((reason) => /schema|final json|JSONL/i.test(reason)),
    ).length,
  };
  const conditionNames = [
    ...new Set(manifest.schedule.flatMap((entry) => entry.conditions)),
  ];

  for (const condition of conditionNames) {
    const all = attempts.filter((attempt) => attempt.entry.condition === condition);
    const valid = all.filter((attempt) => attempt.entry.valid && attempt.score);
    const toolDistribution = {};
    const toolCallDistribution = {};
    const missed = {};
    const dimensionScores = {};
    let exactTasks = 0;
    let taskCount = 0;
    for (const attempt of valid) {
      for (const name of attempt.audit.actual_tool_names) increment(toolDistribution, name);
      for (const call of attempt.audit.actual_calls) {
        increment(toolCallDistribution, canonicalToolName(call.canonical_name));
      }
      for (const task of attempt.score.tasks ?? []) {
        taskCount += 1;
        if (task.score === 1) exactTasks += 1;
        (dimensionScores[task.dimension] ??= []).push(task.score);
        if (task.score !== 1) {
          const item = (missed[task.task_id] ??= {
            task_id: task.task_id,
            misses: 0,
            runs: [],
            likely_failure_modes: {},
          });
          item.misses += 1;
          item.runs.push(attempt.entry.run_id);
          increment(item.likely_failure_modes, likelyFailureMode(task));
        }
      }
    }
    aggregate.conditions[condition] = {
      valid_attempts: valid.length,
      invalid_attempts: all.length - valid.length,
      exact_task_accuracy: taskCount ? exactTasks / taskCount : null,
      mean_score: numberSummary(valid.map((attempt) => attempt.score.quality)).mean,
      score: numberSummary(valid.map((attempt) => attempt.score.quality)),
      dimensions: Object.fromEntries(
        Object.entries(dimensionScores).map(([dimension, values]) => [
          dimension,
          numberSummary(values).mean,
        ]),
      ),
      wall_ms: numberSummary(valid.map((attempt) => attempt.metadata.process.wall_ms)),
      input_tokens: numberSummary(valid.map((attempt) => attempt.metadata.usage.input_tokens)),
      output_tokens: numberSummary(valid.map((attempt) => attempt.metadata.usage.output_tokens)),
      cached_input_tokens: numberSummary(
        valid.map((attempt) => attempt.metadata.usage.cached_input_tokens),
      ),
      uncached_input_tokens: numberSummary(
        valid.map(
          (attempt) =>
            attempt.metadata.usage.input_tokens - attempt.metadata.usage.cached_input_tokens,
        ),
      ),
      reasoning_output_tokens: numberSummary(
        valid.map((attempt) => attempt.metadata.usage.reasoning_output_tokens),
      ),
      total_tokens: numberSummary(valid.map((attempt) => attempt.metadata.usage.total_tokens)),
      tool_calls: numberSummary(valid.map((attempt) => attempt.audit.actual_calls.length)),
      tool_name_distribution: toolDistribution,
      tool_call_distribution: toolCallDistribution,
      graph_tool_calls: numberSummary(
        valid.map(
          (attempt) =>
            attempt.audit.actual_calls.filter((call) =>
              new Set([...GRAPH_TOOLS, ...GRAPH_NEUTRAL_TOOLS]).has(
                canonicalToolName(call.canonical_name),
              ),
            ).length,
        ),
      ),
      explorer_tool_calls: numberSummary(
        valid.map(
          (attempt) =>
            attempt.audit.actual_calls.filter((call) =>
              new Set(EXPLORER_TOOLS).has(canonicalToolName(call.canonical_name)),
            ).length,
        ),
      ),
      successful_graph_evidence_calls: numberSummary(
        valid.map((attempt) => attempt.audit.successful_graph_evidence_calls ?? 0),
      ),
      successful_explorer_evidence_calls: numberSummary(
        valid.map((attempt) => attempt.audit.successful_explorer_evidence_calls ?? 0),
      ),
      forbidden_tool_or_oracle_violations: all.reduce(
        (count, attempt) =>
          count +
          attempt.audit.violations.filter((violation) =>
            ["forbidden_tool", "oracle_access", "unexpected_tool"].includes(violation.kind),
          ).length,
        0,
      ),
      structured_output_failure_rate: all.length
        ? all.filter((attempt) =>
            attempt.entry.invalidation_reasons.some((reason) => /schema|final json|JSONL/i.test(reason)),
          ).length / all.length
        : null,
      missed_tasks: Object.values(missed),
    };
  }

  for (let pair = 1; pair <= manifest.repetitions; pair += 1) {
    const graph = attempts.find(
      (attempt) => attempt.entry.valid && attempt.entry.pair === pair && attempt.entry.condition === "graph",
    );
    const explorer = attempts.find(
      (attempt) =>
        attempt.entry.valid && attempt.entry.pair === pair && attempt.entry.condition === "explorer",
    );
    if (graph?.score && explorer?.score) {
      aggregate.paired_differences.push({
        pair,
        score_graph_minus_explorer: graph.score.quality - explorer.score.quality,
        wall_ms_graph_minus_explorer:
          graph.metadata.process.wall_ms - explorer.metadata.process.wall_ms,
      });
    }
  }
  aggregate.paired_summary = {
    score_graph_minus_explorer: numberSummary(
      aggregate.paired_differences.map((pair) => pair.score_graph_minus_explorer),
    ),
    wall_ms_graph_minus_explorer: numberSummary(
      aggregate.paired_differences.map((pair) => pair.wall_ms_graph_minus_explorer),
    ),
  };

  const validRunPaths = attempts
    .filter((attempt) => attempt.entry.valid)
    .map((attempt) => join(attempt.directory, "run.json"));
  if (validRunPaths.length) {
    const comparison = await spawnProcess(process.execPath, [
      harnessPath,
      "compare",
      ...validRunPaths,
      "--suite",
      resolve(suitePath),
    ]);
    if (comparison.code === 0) {
      aggregate.harness_comparison = readJsonText(comparison.stdout, "harness comparison");
    } else {
      aggregate.harness_comparison_error = comparison.stderr.trim();
    }
  }

  const report = reportMarkdown(aggregate, manifest);
  await atomicWrite(join(absolute, "aggregate.json"), aggregate);
  await atomicWrite(join(absolute, "report.md"), report, 0o600);
  return aggregate;
}

function formatNumber(value, digits = 3) {
  return value == null ? "n/a" : Number(value).toFixed(digits);
}

function singleConditionReportMarkdown(aggregate, manifest, condition) {
  const item = aggregate.conditions[condition];
  const lines = [
    `# zPAM3 ${condition} benchmark`,
    "",
    `Cohort: \`${aggregate.cohort_id}\`  `,
    `Status: **${aggregate.status}**  `,
    `Model: \`${manifest.requested_model}\` at \`${manifest.requested_reasoning_effort}\`  `,
    `Source revision: \`${manifest.source.head}\``,
    "",
    "## Results",
    "",
    "| Condition | Valid | Invalid | Exact task accuracy | Mean score | Median wall ms | Mean total tokens | Mean cached input | Mean uncached input | Mean tool calls |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${condition} | ${item.valid_attempts} | ${item.invalid_attempts} | ${formatNumber(
      item.exact_task_accuracy,
    )} | ${formatNumber(item.mean_score)} | ${formatNumber(
      item.wall_ms.median,
      0,
    )} | ${formatNumber(item.total_tokens.mean, 0)} | ${formatNumber(
      item.cached_input_tokens.mean,
      0,
    )} | ${formatNumber(item.uncached_input_tokens.mean, 0)} | ${formatNumber(
      item.tool_calls.mean,
      1,
    )} |`,
    "",
    "## D1-D5 breakdown",
    "",
    "| Dimension | Mean score |",
    "|---|---:|",
  ];
  for (const dimension of ["D1", "D2", "D3", "D4", "D5"]) {
    lines.push(`| ${dimension} | ${formatNumber(item.dimensions[dimension])} |`);
  }
  lines.push(
    "",
    "## Tool use",
    "",
    `- Mean graph-family calls: ${formatNumber(item.graph_tool_calls.mean, 1)}.`,
    `- Mean explorer-family calls: ${formatNumber(item.explorer_tool_calls.mean, 1)}.`,
    `- Mean successful graph evidence calls: ${formatNumber(
      item.successful_graph_evidence_calls.mean,
      1,
    )}.`,
    `- Mean successful explorer evidence calls: ${formatNumber(
      item.successful_explorer_evidence_calls.mean,
      1,
    )}.`,
    `- Forbidden/oracle violations: ${item.forbidden_tool_or_oracle_violations}.`,
    `- Structured-output failure rate: ${formatNumber(item.structured_output_failure_rate)}.`,
    "",
  );
  const calls = Object.entries(item.tool_call_distribution)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `\`${name}\` (${count} calls)`)
    .join(", ");
  lines.push(`Observed calls: ${calls || "none"}.`, "", "## Invalid attempts", "");
  if (!aggregate.invalid_attempts.length) {
    lines.push("No invalid attempts were recorded.");
  } else {
    for (const attempt of aggregate.invalid_attempts) {
      lines.push(`- \`${attempt.run_id}\`: ${attempt.reasons.join("; ")}`);
    }
  }
  lines.push("", "## Missed tasks", "");
  if (!item.missed_tasks.length) {
    lines.push("No task was missed in a valid run.");
  } else {
    for (const miss of item.missed_tasks) {
      lines.push(
        `- \`${miss.task_id}\`: ${miss.misses} miss(es); ${Object.keys(
          miss.likely_failure_modes,
        ).join(", ")}`,
      );
    }
  }
  lines.push(
    "",
    "## Reproduction and scope",
    "",
    "- Validation gate: `mise run eval:check`.",
    `- Rebuild this report: \`node scripts/run-gsc-agent-benchmark.mjs summarize evaluation/results/zpam3/${aggregate.cohort_id}\`.`,
    `- The corpus stayed pinned at \`${manifest.source.head}\` and was mounted read-only.`,
    "- This is a single-condition cohort; comparisons with earlier baselines are descriptive and unpaired.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function reportMarkdown(aggregate, manifest) {
  const available = Object.keys(aggregate.conditions);
  if (!(available.includes("graph") && available.includes("explorer"))) {
    expect(available.length === 1, `unsupported report condition set: ${available.join(", ")}`);
    return singleConditionReportMarkdown(aggregate, manifest, available[0]);
  }
  const lines = [
    `# zPAM3 graph vs explorer benchmark`,
    "",
    `Cohort: \`${aggregate.cohort_id}\`  `,
    `Status: **${aggregate.status}**  `,
    `Model: \`${manifest.requested_model}\` at \`${manifest.requested_reasoning_effort}\`  `,
    `Source revision: \`${manifest.source.head}\``,
    "",
    "## Results",
    "",
    "| Condition | Valid | Invalid | Exact task accuracy | Mean score | Median wall ms | p95 wall ms | Mean total tokens | Mean tool calls |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const condition of ["graph", "explorer"]) {
    const item = aggregate.conditions[condition];
    lines.push(
      `| ${condition} | ${item.valid_attempts} | ${item.invalid_attempts} | ${formatNumber(
        item.exact_task_accuracy,
      )} | ${formatNumber(item.mean_score)} | ${formatNumber(
        item.wall_ms.median,
        0,
      )} | ${formatNumber(item.wall_ms.p95, 0)} | ${formatNumber(
        item.total_tokens.mean,
        0,
      )} | ${formatNumber(item.tool_calls.mean, 1)} |`,
    );
  }
  lines.push(
    "",
    "## D1-D5 breakdown",
    "",
    "| Dimension | Graph mean score | Explorer mean score | Graph minus explorer |",
    "|---|---:|---:|---:|",
  );
  for (const dimension of ["D1", "D2", "D3", "D4", "D5"]) {
    const graph = aggregate.conditions.graph.dimensions[dimension];
    const explorer = aggregate.conditions.explorer.dimensions[dimension];
    lines.push(
      `| ${dimension} | ${formatNumber(graph)} | ${formatNumber(explorer)} | ${formatNumber(
        graph - explorer,
      )} |`,
    );
  }
  lines.push(
    "",
    "## Paired differences",
    "",
    "| Pair | Score: graph minus explorer | Wall ms: graph minus explorer |",
    "|---:|---:|---:|",
  );
  for (const pair of aggregate.paired_differences) {
    lines.push(
      `| ${pair.pair} | ${formatNumber(pair.score_graph_minus_explorer)} | ${formatNumber(
        pair.wall_ms_graph_minus_explorer,
        0,
      )} |`,
    );
  }
  lines.push(
    "",
    `Graph minus explorer mean score: ${formatNumber(
      aggregate.paired_summary.score_graph_minus_explorer.mean,
    )}.`,
    `Graph minus explorer median wall time: ${formatNumber(
      aggregate.paired_summary.wall_ms_graph_minus_explorer.median,
      0,
    )} ms.`,
    "",
    "These are descriptive results from five paired repetitions; no statistical-significance claim is made.",
    "",
    "## Tool policy and invalid attempts",
    "",
  );
  for (const condition of ["graph", "explorer"]) {
    const item = aggregate.conditions[condition];
    const distribution = Object.entries(item.tool_name_distribution)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `\`${name}\` (${count}/${item.valid_attempts} valid runs)`)
      .join(", ");
    lines.push(
      `- ${condition}: ${item.forbidden_tool_or_oracle_violations} forbidden/oracle violation(s), structured-output failure rate ${formatNumber(
        item.structured_output_failure_rate,
      )}; observed tools: ${distribution || "none"}.`,
    );
  }
  lines.push("");
  if (!aggregate.invalid_attempts.length) {
    lines.push("No invalid attempts were recorded.");
  } else {
    for (const attempt of aggregate.invalid_attempts) {
      lines.push(
        `- \`${attempt.run_id}\` (${attempt.condition}): ${attempt.reasons.join("; ")}`,
      );
    }
  }
  lines.push("", "## Missed tasks", "");
  const misses = ["graph", "explorer"].flatMap((condition) =>
    aggregate.conditions[condition].missed_tasks.map((task) => ({ condition, ...task })),
  );
  if (!misses.length) {
    lines.push("No task was missed in a valid run.");
  } else {
    for (const miss of misses) {
      lines.push(
        `- ${miss.condition} / \`${miss.task_id}\`: ${miss.misses} miss(es); ${Object.keys(
          miss.likely_failure_modes,
        ).join(", ")}`,
      );
    }
  }
  lines.push(
    "",
    "Failure-mode labels are controller heuristics. Grammar failures, graph invariant failures, tool-routing violations, structured-output failures, and scorer failures are reported separately in raw attempt metadata; otherwise misses are attributed conservatively to lookup/reasoning or ordinary model variance.",
    "",
    "## Ranked improvements",
    "",
  );
  const improvementByDimension = {
    D1: "Improve graph definition lookup and evidence paths so exact-name searches consistently return the defining file and count.",
    D2: "Improve inbound-call tracing and caller-identity completeness, especially exact caller counts and path-qualified identities.",
    D3: "Surface stable source spans in graph/snippet results so agents can report exact start and end lines without direct file reads.",
    D4: "Tighten path-qualified include and startup-call resolution while preserving the strong existing D4 performance.",
    D5: "Expose ambiguity and candidate counts explicitly so unresolved references are distinguished from missing definitions.",
  };
  const rankedDimensions = ["D1", "D2", "D3", "D4", "D5"].sort((left, right) => {
    const leftGap =
      aggregate.conditions.explorer.dimensions[left] - aggregate.conditions.graph.dimensions[left];
    const rightGap =
      aggregate.conditions.explorer.dimensions[right] - aggregate.conditions.graph.dimensions[right];
    return rightGap - leftGap;
  });
  rankedDimensions.forEach((dimension, index) => {
    const gap =
      aggregate.conditions.explorer.dimensions[dimension] -
      aggregate.conditions.graph.dimensions[dimension];
    lines.push(
      `${index + 1}. **${dimension} (observed score gap ${formatNumber(gap)}):** ${improvementByDimension[dimension]}`,
    );
  });
  const graphWall = aggregate.conditions.graph.wall_ms.median;
  const explorerWall = aggregate.conditions.explorer.wall_ms.median;
  const graphTokens = aggregate.conditions.graph.total_tokens.mean;
  const explorerTokens = aggregate.conditions.explorer.total_tokens.mean;
  lines.push(
    `${rankedDimensions.length + 1}. **Efficiency after quality:** reduce graph round trips and repeated broad queries; graph median wall time was ${formatNumber(
      graphWall / explorerWall,
      2,
    )}x explorer and mean total tokens were ${formatNumber(
      graphTokens / explorerTokens,
      2,
    )}x explorer.`,
    "",
    "## Reproduction and scope",
    "",
    "- Validation gate: `mise run eval:check`.",
    "- No-spend audit: `node scripts/run-gsc-agent-benchmark.mjs run --dry-run ...`.",
    `- Rebuild this report: \`node scripts/run-gsc-agent-benchmark.mjs summarize evaluation/results/zpam3/${aggregate.cohort_id}\`.`,
    `- The public zPAM3 corpus stayed pinned at \`${manifest.source.head}\` and was mounted read-only for every model run.`,
    "- Benchmark results remain under the gitignored `evaluation/results/` tree; the runner does not commit or push.",
    "- Oracle-path audits reject the suite, scorer, fixtures, prior results, and private Jump4life paths; no private Jump4life content entered the public corpus artifacts.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function preflightCommand(options, positionals) {
  expect(positionals.length === 0, "preflight does not take positional arguments");
  const common = commonOptions(options);
  expect(common.corpus, "--corpus is required");
  const temporary = await mkdtemp(join(tmpdir(), "gsc-agent-benchmark-preflight-"));
  const cacheDir = join(temporary, "cbm-cache");
  const auditDir = join(temporary, "prompt-prefix-audit");
  let preflight = null;
  try {
    preflight = await performPreflight({
      common,
      cacheDir,
      auditDir,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
    const output = {
      status: "passed",
      suite_id: preflight.suite.suite_id,
      source: preflight.facts.source,
      codex_cli_version: preflight.facts.codex_cli_version,
      binary: preflight.facts.binary,
      graph: {
        project: preflight.facts.graph.project,
        function_count: preflight.facts.graph.function_count,
        direct_callers: preflight.facts.graph.direct_callers,
        d4_path_qualified_edges: preflight.facts.graph.d4_path_qualified_edges.length,
      },
      prompt_audit: preflight.facts.prompt_audit,
      no_spend_gates: preflight.facts.no_spend_gates,
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (preflight?.codexHome?.path) {
      await rm(preflight.codexHome.path, { recursive: true, force: true });
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runCommand(options, positionals) {
  expect(positionals.length === 0, "run does not take positional arguments");
  const common = commonOptions(options);
  expect(common.corpus, "--corpus is required");
  const model = options.model ?? "gpt-5.6-sol";
  const reasoningEffort = options["reasoning-effort"] ?? "xhigh";
  const repetitions = parseInteger(options.repetitions ?? 5, "--repetitions", { minimum: 1 });
  const seed = options.seed ?? "zpam3-v1-sol56-xhigh";
  const hybridOnly = Boolean(options["hybrid-only"]);
  const timeoutMs = common.commandTimeoutMs;
  const killGraceMs = parseInteger(options["kill-grace-ms"] ?? 5_000, "--kill-grace-ms", {
    minimum: 100,
  });
  const maxInfrastructureRetries = parseInteger(
    options["max-infrastructure-retries"] ?? 2,
    "--max-infrastructure-retries",
  );
  expect(reasoningEffort === "xhigh", "this cohort requires --reasoning-effort xhigh");
  expect(model === "gpt-5.6-sol", "this cohort requires --model gpt-5.6-sol");
  scheduleFor(repetitions, { hybridOnly });
  expect(!(options.resume && options["dry-run"]), "--resume and --dry-run cannot be combined");

  const resultsRoot = resolve(options["results-root"] ?? defaultResultsRoot);
  const cohortDir = options["cohort-dir"]
    ? resolve(options["cohort-dir"])
    : join(resultsRoot, cohortId(seed));
  let manifest = options.resume ? await readJson(join(cohortDir, "manifest.json")) : null;
  if (options.resume) {
    expect(options["cohort-dir"], "--resume requires --cohort-dir");
    expect(
      (manifest.run_mode === "hybrid-only") === hybridOnly,
      `resume mode mismatch: cohort is ${manifest.run_mode ?? "paired"}`,
    );
  } else {
    expect(
      !(await lstat(cohortDir).catch(() => null)),
      `cohort directory already exists and will not be overwritten: ${cohortDir}`,
    );
    await mkdir(join(cohortDir, "attempts"), { recursive: true, mode: 0o700 });
    await mkdir(join(cohortDir, "prompt-prefix-audit"), { recursive: true, mode: 0o700 });
  }

  // The local CBM daemon deliberately rejects a cache beneath any
  // group/world-writable ancestor. Some development workspace roots are 0775,
  // so keep the real cache below the owner's private cache directory and
  // expose it at the documented cohort path with a directory symlink.
  const cacheDir = options.resume
    ? manifest.graph.cache_dir
    : join(
        homedir(),
        ".cache",
        "tree-sitter-gsc",
        "agent-benchmark",
        basename(cohortDir),
        "cbm-cache",
      );
  const cacheArtifact = join(cohortDir, "cbm-cache");
  if (!options.resume) {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await symlink(cacheDir, cacheArtifact, "dir");
  } else {
    expect((await stat(cacheDir).catch(() => null))?.isDirectory(), `cohort cache is missing: ${cacheDir}`);
    expect((await lstat(cacheArtifact).catch(() => null))?.isSymbolicLink(), "cohort cbm-cache link is missing");
  }
  const auditDir = join(cohortDir, "prompt-prefix-audit");
  let preflight = null;
  try {
    preflight = await performPreflight({
      common,
      cacheDir,
      auditDir,
      model,
      reasoningEffort,
      reuseCache: Boolean(options.resume),
    });
    preflight.facts.codex_home = preflight.codexHome.path;
    if (options.resume) {
      await assertResumeCompatible(manifest, preflight, {
        common,
        model,
        reasoningEffort,
        repetitions,
        seed,
        hybridOnly,
      });
    } else {
      manifest = await initializeManifest({
        cohortDir,
        common,
        preflight,
        model,
        reasoningEffort,
        repetitions,
        seed,
        hybridOnly,
      });
    }
    if (options["dry-run"]) {
      const plan = dryRunPlan({
        common,
        preflight,
        manifest,
        model,
        reasoningEffort,
        cohortDir,
      });
      manifest.status = "dry-run-complete";
      manifest.dry_run = {
        completed_at: new Date().toISOString(),
        file: "dry-run.json",
      };
      await atomicWrite(join(cohortDir, "dry-run.json"), plan);
      await atomicWrite(join(cohortDir, "manifest.json"), manifest);
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    manifest.status = "running";
    await atomicWrite(join(cohortDir, "manifest.json"), manifest);
    let attemptNumber = manifest.attempts.length + 1;
    for (const scheduled of manifest.schedule) {
      for (const condition of scheduled.conditions) {
        if (
          manifest.attempts.some(
            (attempt) =>
              attempt.pair === scheduled.pair && attempt.condition === condition && attempt.valid,
          )
        ) {
          continue;
        }
        let infrastructureRetries = 0;
        let tryNumber = manifest.attempts.filter(
          (attempt) => attempt.pair === scheduled.pair && attempt.condition === condition,
        ).length;
        while (true) {
          tryNumber += 1;
          const attempt = await executeAttempt({
            number: attemptNumber++,
            condition,
            pair: scheduled.pair,
            tryNumber,
            cohortDir,
            common,
            suite: preflight.suite,
            preflight: preflight.facts,
            model,
            reasoningEffort,
            timeoutMs,
            killGraceMs,
          });
          manifest.attempts.push(attempt);
          await atomicWrite(join(cohortDir, "manifest.json"), manifest);
          if (requestedSignal) {
            manifest.status = "interrupted";
            manifest.stopped_at = new Date().toISOString();
            manifest.stop_reason = requestedSignal;
            await atomicWrite(join(cohortDir, "manifest.json"), manifest);
            await summarizeCohort(cohortDir, common.suitePath);
            fail(`benchmark interrupted by ${requestedSignal}`);
          }
          if (attempt.valid) break;
          if (shouldRetryAttempt(attempt, infrastructureRetries, maxInfrastructureRetries)) {
            infrastructureRetries += 1;
            continue;
          }
          manifest.status = "invalidated";
          manifest.stopped_at = new Date().toISOString();
          manifest.stop_reason = `could not obtain a valid ${condition} run for pair ${scheduled.pair}`;
          await atomicWrite(join(cohortDir, "manifest.json"), manifest);
          await summarizeCohort(cohortDir, common.suitePath);
          fail(manifest.stop_reason);
        }
      }
      if (scheduled.pair === 1 && options["smoke-only"]) {
        manifest.status = "smoke-complete";
        manifest.smoke_completed_at = new Date().toISOString();
        await atomicWrite(join(cohortDir, "manifest.json"), manifest);
        await summarizeCohort(cohortDir, common.suitePath);
        console.log(`Smoke pair complete: ${cohortDir}`);
        return;
      }
      if (requestedSignal) {
        manifest.status = "interrupted";
        manifest.stopped_at = new Date().toISOString();
        manifest.stop_reason = requestedSignal;
        await atomicWrite(join(cohortDir, "manifest.json"), manifest);
        fail(`benchmark interrupted by ${requestedSignal}`);
      }
    }
    manifest.status = "complete";
    manifest.completed_at = new Date().toISOString();
    await atomicWrite(join(cohortDir, "manifest.json"), manifest);
    await summarizeCohort(cohortDir, common.suitePath);
    console.log(`Benchmark cohort complete: ${cohortDir}`);
  } finally {
    if (preflight?.codexHome?.path) {
      await rm(preflight.codexHome.path, { recursive: true, force: true });
    }
  }
}

async function summarizeCommand(options, positionals) {
  expect(positionals.length === 1, "summarize requires exactly one cohort directory");
  const aggregate = await summarizeCohort(
    resolve(positionals[0]),
    resolve(options.suite ?? defaultSuitePath),
  );
  console.log(
    JSON.stringify(
      {
        cohort_id: aggregate.cohort_id,
        status: aggregate.status,
        conditions: aggregate.conditions,
        paired_summary: aggregate.paired_summary,
        invalid_attempts: aggregate.invalid_attempts,
      },
      null,
      2,
    ),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options, positionals } = parseCli(argv);
  if (command === "help" || options.help) {
    console.log(usage());
    return;
  }
  const removeSignalHandlers = installSignalHandlers();
  try {
    if (command === "preflight") await preflightCommand(options, positionals);
    else if (command === "run") await runCommand(options, positionals);
    else if (command === "summarize") await summarizeCommand(options, positionals);
  } finally {
    removeSignalHandlers();
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    console.error(`gsc-agent-benchmark: ${error.message}`);
    process.exitCode = requestedSignal === "SIGINT" ? 130 : requestedSignal === "SIGTERM" ? 143 : 1;
  });
}
