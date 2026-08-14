#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedRevision = "83285ae8d2ba65640cf46318feade49463652a06";
const expectedFileCount = 180;
const expectedDefinitionCount = 1580;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result.stdout;
}

function collectGscFiles(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectGscFiles(path, result);
    } else if (entry.isFile() && entry.name.endsWith(".gsc")) {
      result.push(path);
    }
  }
  return result;
}

try {
  const targetValue = process.env.ZPAM3_ROOT;
  if (!targetValue) {
    fail("ZPAM3_ROOT must point to a zPAM3 Git checkout");
  }

  const targetRoot = resolve(targetValue);
  const revision = run("git", ["-C", targetRoot, "rev-parse", "HEAD"]).trim();
  if (revision !== expectedRevision) {
    fail(`zPAM3 revision must be ${expectedRevision}, got ${revision}`);
  }

  const files = collectGscFiles(join(targetRoot, "source")).sort();
  if (files.length !== expectedFileCount) {
    fail(`zPAM3 GSC file count must be ${expectedFileCount}, got ${files.length}`);
  }

  const syntaxTrees = run("tree-sitter", ["parse", ...files]);
  const definitions = syntaxTrees.match(/\(function_definition\b/g)?.length || 0;
  if (definitions !== expectedDefinitionCount) {
    fail(
      `zPAM3 function definition count must be ${expectedDefinitionCount}, got ${definitions}`,
    );
  }

  console.log(
    `zPAM3 gate: ${files.length} GSC files, ${definitions} function definitions, revision ${revision.slice(0, 7)}`,
  );
} catch (error) {
  console.error(`test-zpam3: ${error.message}`);
  process.exitCode = 1;
}
