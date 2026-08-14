#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repoRoot, "test", "fixtures", "codebase-memory");
const patchPath = join(repoRoot, "integration", "codebase-memory-mcp.patch");
const cbmRootValue = process.env.CBM_ROOT;

if (!cbmRootValue) {
  console.error("CBM_ROOT must point to an existing codebase-memory-mcp Git checkout.");
  process.exit(2);
}

const cbmRoot = resolve(cbmRootValue);
const tempBase = resolve(process.env.CBM_TMP_ROOT || tmpdir());
const relativeTempBase = relative(repoRoot, tempBase);

if (relativeTempBase === "" || (!relativeTempBase.startsWith(`..${sep}`) && relativeTempBase !== ".." && !isAbsolute(relativeTempBase))) {
  console.error("CBM_TMP_ROOT must be outside tree-sitter-gsc repository.");
  process.exit(2);
}

const workRoot = mkdtempSync(join(tempBase, "tree-sitter-gsc-cbm-"));
const sourceRoot = join(workRoot, "codebase-memory-mcp");
const cacheRoot = join(workRoot, "cache");
const xdgCacheRoot = join(workRoot, "xdg-cache");
const archivePath = join(workRoot, "codebase-memory-mcp.tar");
const logPath = join(workRoot, "gate.log");
const indexLogPath = join(workRoot, "index.log");
const project = "tree-sitter-gsc-e2e";
const keepTemp = process.env.CBM_KEEP_TMP === "1";
let passed = false;
let argsSequence = 0;

mkdirSync(sourceRoot, { recursive: true });
mkdirSync(cacheRoot, { recursive: true });
mkdirSync(xdgCacheRoot, { recursive: true });

const childEnv = {
  ...process.env,
  CBM_CACHE_DIR: cacheRoot,
  CBM_INDEX_LOG: indexLogPath,
  XDG_CACHE_HOME: xdgCacheRoot,
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || childEnv,
    encoding: options.capture === false ? undefined : "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio,
  });

  if (result.error && result.status === null) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = options.capture === false
      ? `see ${logPath}`
      : (result.stderr || result.stdout || `exit ${result.status}`).trim();
    fail(`${command} failed: ${detail}`);
  }
  return result.stdout || "";
}

function runLogged(command, args, cwd) {
  const logFd = openSync(logPath, "a");
  try {
    run(command, args, {
      cwd,
      capture: false,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
}

function runTool(binary, tool, args) {
  const argsPath = join(workRoot, `args-${argsSequence += 1}.json`);
  writeFileSync(argsPath, `${JSON.stringify(args)}\n`);
  const result = spawnSync(binary, ["cli", tool, "--args-file", argsPath], {
    cwd: repoRoot,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  appendFileSync(logPath, result.stderr || "");
  unlinkSync(argsPath);

  if (result.error && result.status === null) {
    fail(`${tool} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${tool} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }

  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    fail(`${tool} returned invalid JSON: ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function sameMembers(actual, expected) {
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

try {
  expect(existsSync(join(cbmRoot, ".git")), "CBM_ROOT is not a Git checkout");
  expect(existsSync(join(cbmRoot, "Makefile.cbm")), "CBM_ROOT lacks Makefile.cbm");
  expect(existsSync(patchPath), "integration patch is missing");

  run("git", ["-C", cbmRoot, "archive", "--format=tar", `--output=${archivePath}`, "HEAD"]);
  run("tar", ["-xf", archivePath, "-C", sourceRoot]);
  unlinkSync(archivePath);

  const patchCheck = spawnSync("git", ["apply", "--check", patchPath], {
    cwd: sourceRoot,
    env: childEnv,
    encoding: "utf8",
  });
  if (patchCheck.status === 0) {
    run("git", ["apply", patchPath], { cwd: sourceRoot });
  } else {
    const reverseCheck = spawnSync("git", ["apply", "--reverse", "--check", patchPath], {
      cwd: sourceRoot,
      env: childEnv,
      encoding: "utf8",
    });
    if (reverseCheck.status !== 0) {
      // The pinned GSC branch contains a later caller-identity fix that updates
      // tests/test_edge_imports.c after the integration patch was committed.
      // Require every implementation hunk to reverse cleanly while allowing
      // that test file to have advanced; the functional assertions below still
      // exercise the integrated import and call-resolution behavior.
      const reverseImplementationCheck = spawnSync(
        "git",
        [
          "apply",
          "--reverse",
          "--check",
          "--exclude=tests/test_edge_imports.c",
          patchPath,
        ],
        {
          cwd: sourceRoot,
          env: childEnv,
          encoding: "utf8",
        },
      );
      expect(
        reverseImplementationCheck.status === 0,
        "integration patch implementation does not apply to CBM_ROOT HEAD",
      );
    }
  }

  const jobs = availableParallelism?.() || cpus().length || 1;
  runLogged("make", ["-f", "Makefile.cbm", `-j${jobs}`, "cbm"], sourceRoot);
  const binary = join(sourceRoot, "build", "c", "codebase-memory-mcp");
  expect(existsSync(binary), "MCP build did not produce build/c/codebase-memory-mcp");

  const gscFiles = run("find", [fixtureRoot, "-type", "f", "-name", "*.gsc", "-print"])
    .trim()
    .split("\n")
    .filter(Boolean);
  const expectedGscPaths = gscFiles.map((file) => relative(fixtureRoot, file).split(sep).join("/"));
  expect(expectedGscPaths.length === 4, `fixture contains ${expectedGscPaths.length} GSC files, expected 4`);

  const treeSitter = process.env.TREE_SITTER || "tree-sitter";
  const queryOutput = run(treeSitter, [
    "query",
    "--grammar-path",
    repoRoot,
    join(repoRoot, "queries", "tags.scm"),
    ...gscFiles,
  ]);
  const definitionCaptures = queryOutput.match(/capture: (?:\d+ - )?definition\.function/g) || [];
  expect(definitionCaptures.length === 6, `Tree-sitter captured ${definitionCaptures.length} functions, expected 6`);

  const indexed = runTool(binary, "index_repository", {
    repo_path: fixtureRoot,
    mode: "fast",
    name: project,
    persistence: false,
  });
  expect(indexed.status === "indexed", `index status is ${JSON.stringify(indexed.status)}`);
  expect(Number(indexed.skipped_count) === 0, `${indexed.skipped_count} files skipped`);
  expect(Number(indexed.parse_partial_count) === 0, `${indexed.parse_partial_count} partial parses`);
  expect(Number(indexed.not_indexed_files_count) === 0, `${indexed.not_indexed_files_count} files not indexed`);

  const files = runTool(binary, "query_graph", {
    project,
    format: "json",
    query: "MATCH (f:File) RETURN f.file_path, f.extension",
  });
  const indexedGscPaths = files.rows
    .filter((row) => row[1] === ".gsc")
    .map((row) => row[0]);
  expect(sameMembers(indexedGscPaths, expectedGscPaths), "indexed GSC file set differs from fixture");

  const functions = runTool(binary, "query_graph", {
    project,
    format: "json",
    query: "MATCH (f:Function) RETURN count(f)",
  });
  const functionCount = Number(functions.rows?.[0]?.[0]);
  expect(functionCount === definitionCaptures.length, `MCP found ${functionCount} functions; Tree-sitter found ${definitionCaptures.length}`);

  const calls = runTool(binary, "query_graph", {
    project,
    format: "json",
    query: "MATCH (a)-[r:CALLS]->(b) RETURN a.qualified_name, b.qualified_name, r.callee, r.module_path, r.strategy",
  });
  const directCall = calls.rows.find((row) => row[2] === "local_target");
  expect(
    directCall?.[0] === `${project}.cod2.main.main`
      && directCall?.[1] === `${project}.cod2.main.local_target`
      && directCall?.[4] === "gsc_local",
    "representative direct call did not resolve locally",
  );
  const qualifiedCall = calls.rows.find((row) => row[2] === "qualified_target");
  expect(
    qualifiedCall?.[0] === `${project}.cod2.main.main`
      && qualifiedCall?.[1] === `${project}.shared.lib.helper.qualified_target`
      && qualifiedCall?.[3] === "FixtureAlias\\helper"
      && qualifiedCall?.[4] === "gsc_module_path",
    "representative qualified call did not resolve through alias",
  );
  expect(!calls.rows.some((row) => row[2] === "ambiguous_target"), "ambiguous call resolved to arbitrary target");

  const trace = runTool(binary, "trace_path", {
    project,
    function_name: `${project}.cod2.main.main`,
    direction: "outbound",
    mode: "calls",
    depth: 2,
    format: "json",
  });
  const qualifiedTraceGroup = trace.callees?.groups?.find(
    (group) => group.qn_prefix === `${project}.shared.lib.helper`,
  );
  expect(
    qualifiedTraceGroup?.rows?.some((row) => row[0] === "qualified_target" && Number(row[1]) === 1),
    "trace_path did not reach qualified target",
  );

  const imports = runTool(binary, "query_graph", {
    project,
    format: "json",
    query: "MATCH (a)-[r:IMPORTS]->(b) RETURN a.qualified_name, b.qualified_name, r.local_name",
  });
  expect(
    imports.rows.some((row) => row[0] === `${project}.cod2.main.gsc.__file__`
      && row[1] === `${project}.shared.lib.helper`
      && row[2] === "helper"),
    "representative include did not resolve through alias",
  );

  const ambiguous = runTool(binary, "get_code_snippet", {
    project,
    qualified_name: "ambiguous_target",
  });
  expect(ambiguous.status === "ambiguous", "ambiguous bare function returned a target");
  expect(ambiguous.suggestions?.length === 2, "ambiguous bare function did not return two suggestions");
  expect(
    sameMembers(
      ambiguous.suggestions.map((suggestion) => suggestion.file_path),
      ["shared/duplicates/first.gsc", "shared/duplicates/second.gsc"],
    ),
    "ambiguous bare function returned wrong suggestions",
  );

  const snippet = runTool(binary, "get_code_snippet", {
    project,
    qualified_name: `${project}.cod2.main.local_target`,
  });
  expect(snippet.start_line === 10 && snippet.end_line === 13, "snippet source range is not lines 10-13");
  expect(snippet.source === "local_target()\n{\n    return \"local\";\n}\n", "snippet source does not match exact fixture range");

  console.log(
    `codebase-memory gate: ${indexedGscPaths.length} GSC files, ${functionCount} functions, `
      + `${calls.total} resolved calls, ${imports.total} include; all checks passed`,
  );
  passed = true;
} catch (error) {
  console.error(`codebase-memory gate failed: ${error.message}`);
  console.error(`log: ${logPath}`);
  process.exitCode = 1;
} finally {
  if (passed && !keepTemp) {
    rmSync(workRoot, { recursive: true, force: true });
  } else if (keepTemp) {
    console.error(`temporary files: ${workRoot}`);
  }
}
