#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = `Usage:
  CBM_ROOT=/path/to/codebase-memory-mcp node scripts/sync-codebase-memory-vendor.mjs [--check|--write]

Modes:
  --check  Fail when the vendored GSC parser differs (default).
  --write  Copy the generated parser, parser header, and license into CBM_ROOT.`;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex").slice(0, 12);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

const unknownArgs = args.filter((arg) => arg !== "--check" && arg !== "--write");
if (unknownArgs.length > 0 || (args.includes("--check") && args.includes("--write"))) {
  fail(`Invalid arguments: ${args.join(" ")}\n\n${usage}`);
  process.exit();
}

const mode = args.includes("--write") ? "write" : "check";
const cbmRootInput = process.env.CBM_ROOT;
if (!cbmRootInput) {
  fail(`CBM_ROOT is required.\n\n${usage}`);
  process.exit();
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cbmRoot = resolve(cbmRootInput);
const vendorRoot = join(cbmRoot, "internal", "cbm", "vendored", "grammars", "gsc");

try {
  const gitMetadata = await stat(join(cbmRoot, ".git"));
  if (!gitMetadata.isDirectory() && !gitMetadata.isFile()) {
    throw new Error(".git is not repository metadata");
  }
} catch {
  fail(`CBM_ROOT is not a Git checkout: ${cbmRoot}`);
  process.exit();
}

const files = [
  { source: "src/parser.c", destination: "parser.c" },
  { source: "src/tree_sitter/parser.h", destination: "tree_sitter/parser.h" },
  { source: "LICENSE", destination: "LICENSE" },
];

const differences = [];

for (const file of files) {
  const sourcePath = join(repositoryRoot, file.source);
  const destinationPath = join(vendorRoot, file.destination);
  const sourceContents = await readFile(sourcePath);
  let destinationContents;

  try {
    destinationContents = await readFile(destinationPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (destinationContents?.equals(sourceContents)) {
    continue;
  }

  differences.push({
    ...file,
    sourcePath,
    destinationPath,
    sourceDigest: digest(sourceContents),
    destinationDigest: destinationContents ? digest(destinationContents) : "missing",
  });

  if (mode === "write") {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

if (differences.length === 0) {
  console.log(`GSC vendor is in sync: ${files.length} files`);
  process.exit(0);
}

for (const difference of differences) {
  const action = mode === "write" ? "updated" : "out of sync";
  console.log(
    `${action}: ${difference.destination} ` +
      `(${difference.destinationDigest} -> ${difference.sourceDigest})`,
  );
}

if (mode === "write") {
  console.log(`GSC vendor sync complete: ${differences.length} files updated`);
} else {
  fail(
    `GSC vendor check failed: ${differences.length} files differ. ` +
      `Run with --write to update CBM_ROOT.`,
  );
}
