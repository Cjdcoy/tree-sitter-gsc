#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pinnedCommit = "717759afcd20f02c697105f82565fd2cabdd9b24";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamValue = process.env.VSCODE_COD_GSC_ROOT;

const expectedErrors = new Map([
  [
    "GscAll.CoD2MP/casting.gsc",
    "CoD2 configuration rejects cast syntax",
  ],
  [
    "GscAll.UniversalGame/casting.gsc",
    "universal cast expressions remain unsupported",
  ],
  [
    "GscCompletionItemProvider/variablesLevel.gsc",
    "incomplete member access exists for completion recovery",
  ],
  [
    "GscExcludePaths/animtrees/tree1.gsc",
    "path-filter fixture contains an incomplete placeholder statement",
  ],
  [
    "GscExcludePaths/excluded_folder/should_be_excluded.gsc",
    "excluded-path fixture contains an incomplete placeholder statement",
  ],
  [
    "GscExcludePaths/scripts/also_included.gsc",
    "path-filter fixture contains an incomplete placeholder statement",
  ],
  [
    "GscExcludePaths/scripts/included.gsc",
    "path-filter fixture contains an incomplete placeholder statement",
  ],
  [
    "GscFiles/scripts/file1.gsc",
    "file-discovery fixture contains an incomplete placeholder statement",
  ],
  [
    "GscFiles/scripts/file2.gsc",
    "file-discovery fixture contains an incomplete placeholder statement",
  ],
  [
    "GscFiles/scripts3/file3.gsc",
    "file-discovery fixture contains an incomplete placeholder statement",
  ],
  [
    "GscFiles/scripts3/subscripts3/subfile3.gsc",
    "file-discovery fixture contains an incomplete placeholder statement",
  ],
]);

if (!upstreamValue) {
  console.error("VSCODE_COD_GSC_ROOT must point to an existing vscode-cod-gsc Git checkout.");
  process.exit(2);
}

const upstreamRoot = resolve(upstreamValue);
const workspaceRoot = join(upstreamRoot, "src", "test", "workspace");
const cacheRoot = mkdtempSync(join(tmpdir(), "tree-sitter-gsc-vscode-"));

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error && result.status === null) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result.stdout.trim();
}

function collectGscFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectGscFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".gsc") ? [path] : [];
    });
}

function normalizedRelative(path) {
  return relative(workspaceRoot, path).split(sep).join("/");
}

function formatList(items) {
  return items.map((item) => `  - ${item}`).join("\n");
}

try {
  expect(existsSync(join(upstreamRoot, ".git")), "VSCODE_COD_GSC_ROOT is not a Git checkout");
  expect(existsSync(workspaceRoot), "upstream checkout lacks src/test/workspace");

  const commit = run("git", ["-C", upstreamRoot, "rev-parse", "HEAD"]);
  expect(commit === pinnedCommit, `upstream HEAD is ${commit}; expected pinned ${pinnedCommit}`);

  const files = collectGscFiles(workspaceRoot).sort();
  const relativeFiles = files.map(normalizedRelative);
  expect(files.length === 84, `upstream fixture count is ${files.length}; expected 84`);
  for (const allowlistedPath of expectedErrors.keys()) {
    expect(relativeFiles.includes(allowlistedPath), `allowlisted fixture missing: ${allowlistedPath}`);
  }

  const treeSitter = process.env.TREE_SITTER || "tree-sitter";
  const parse = spawnSync(treeSitter, ["parse", "--quiet", "--stat", ...files], {
    cwd: repoRoot,
    env: {
      ...process.env,
      XDG_CACHE_HOME: cacheRoot,
      TREE_SITTER_NUM_THREADS: String(availableParallelism?.() || 1),
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (parse.error && parse.status === null) {
    fail(`${treeSitter} failed to start: ${parse.error.message}`);
  }
  expect(parse.status === 1, `tree-sitter parse exited ${parse.status}; expected fixture-error status 1`);

  const output = `${parse.stdout || ""}\n${parse.stderr || ""}`;
  const summary = output.match(/Total parses: (\d+); successful parses: (\d+); failed parses: (\d+)/);
  expect(summary, "tree-sitter parse summary missing");
  expect(Number(summary[1]) === files.length, `tree-sitter parsed ${summary[1]} files; expected ${files.length}`);

  const failedFiles = new Set();
  for (const line of output.split("\n")) {
    const match = line.match(/^(.*?)\s+Parse:.*\((?:ERROR|MISSING)\b/);
    if (!match) {
      continue;
    }
    const absolutePath = match[1].trim();
    failedFiles.add(normalizedRelative(absolutePath));
  }
  expect(
    failedFiles.size === Number(summary[3]),
    `identified ${failedFiles.size} failed files; parser reported ${summary[3]}`,
  );

  const unexpectedErrors = [...failedFiles].filter((path) => !expectedErrors.has(path)).sort();
  const unexpectedSuccesses = [...expectedErrors.keys()].filter((path) => !failedFiles.has(path)).sort();
  if (unexpectedErrors.length > 0) {
    fail(`unexpected parse errors:\n${formatList(unexpectedErrors)}`);
  }
  if (unexpectedSuccesses.length > 0) {
    fail(`expected-error fixtures now parse; update allowlist deliberately:\n${formatList(unexpectedSuccesses)}`);
  }

  const groups = new Map();
  for (const path of relativeFiles) {
    const groupName = path.split("/")[0];
    const group = groups.get(groupName) || { total: 0, failed: 0 };
    group.total += 1;
    group.failed += failedFiles.has(path) ? 1 : 0;
    groups.set(groupName, group);
  }

  const cod2Groups = [
    "GscAll.CoD2MP",
    "GscAll.CoD2MPZkLibcod",
    "GscAll.CoD2MPCod2x",
  ];
  let cod2Total = 0;
  let cod2Failed = 0;
  for (const groupName of cod2Groups) {
    const group = groups.get(groupName);
    expect(group, `missing CoD2 fixture folder: ${groupName}`);
    cod2Total += group.total;
    cod2Failed += group.failed;
    console.log(`${groupName}: ${group.total - group.failed}/${group.total} valid, ${group.failed} expected error`);
  }
  expect(cod2Total === 21 && cod2Failed === 1, `CoD2 split is ${cod2Total - cod2Failed}/${cod2Total}; expected 20/21`);

  const cod2ValidTotal = cod2Total - cod2Failed;
  console.log(`CoD2 valid fixtures: ${cod2ValidTotal}/${cod2ValidTotal} pass; intentional invalid: ${cod2Failed}/1 expected error`);

  const universal = groups.get("GscAll.UniversalGame");
  expect(universal, "missing universal fixture folder: GscAll.UniversalGame");
  console.log(
    `GscAll.UniversalGame: ${universal.total - universal.failed}/${universal.total} valid, ${universal.failed} expected error`,
  );

  const otherTotal = files.length - cod2Total - universal.total;
  const otherFailed = failedFiles.size - cod2Failed - universal.failed;
  console.log(`other fixtures: ${otherTotal - otherFailed}/${otherTotal} valid, ${otherFailed} expected errors`);
  console.log(`vscode-cod-gsc ${commit.slice(0, 7)}: ${files.length - failedFiles.size}/${files.length} valid; allowlist stable`);
} catch (error) {
  console.error(`vscode-cod-gsc gate failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(cacheRoot, { recursive: true, force: true });
}
