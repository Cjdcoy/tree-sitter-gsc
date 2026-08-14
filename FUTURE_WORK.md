# Future work: GSC grammar and codebase-memory-mcp

This document is a handoff for agents extending `tree-sitter-gsc` and its
`codebase-memory-mcp` integration.

## Mission

Primary target: Call of Duty 2 GSC.

Keep responsibilities separate:

- `tree-sitter-gsc` parses syntax and exposes stable AST node/field names.
- `codebase-memory-mcp` discovers `.gsc` files and extracts graph data.
- `vscode-cod-gsc` remains the semantic/dialect reference for diagnostics,
  built-in functions, completion, rename, and other editor behavior.

Tree-sitter should not silently become a second linter. The current policy is
CoD2-first with explicitly documented permissive compatibility: corpus and
semantic gates define CoD2 support, while parse success alone does not claim a
construct is valid for CoD2. Task 5 tracks the remaining policy detail.

## Reference baseline

Baseline measured against:

- External CoD2 GSC corpus: 795 files, not included in this repository.
- vscode-cod-gsc commit:
  `717759afcd20f02c697105f82565fd2cabdd9b24`
- codebase-memory-mcp commit:
  `7d6cdb2`

Current grammar results:

- Local corpus: 5/5 tests pass.
- External CoD2 corpus: 795/795 GSC files parse without errors.
- vscode-cod-gsc CoD2 folders: 20/20 valid fixtures parse.
- vscode-cod-gsc has one additional CoD2 cast fixture which is intentionally
  invalid; grammar rejects it too.
- All vscode-cod-gsc fixtures: 73/84 parse. Ten rejected fixtures are
  intentionally malformed or invalid for CoD2. Remaining false negative is
  universal/CoD1-style casting such as `(int)1`.

Pre-fix production MCP baseline on an external GSC-only CoD2 corpus:

- 7,104 function nodes.
- 63,434 syntactic call occurrences captured by Tree-sitter tags.
- 10,779 resolved/deduplicated `CALLS` edges.
- 8,741 total nodes and 34,350 total edges.
- Zero skipped or unindexed files.
- Seven partial files, all `.cfg`; no partial `.gsc` files.
- 336 `#include` directives extracted, but only two resolved `IMPORTS`
  edges in the source-tree layout.

The repeatable integration fixture now passes with four discovered GSC files,
six function definitions, two resolved calls, one resolved include, exact
snippet ranges, ambiguity checks, and an isolated cache. The integration patch
applies cleanly to the documented `7d6cdb2` baseline and its three vendored
grammar files pass `vendor:check`.

Current public evaluation baseline:

- zPAM3 revision `83285ae`: 180 GSC files and 1,580 function definitions.
- Agent-evaluation validation: 21/21 controller and runner tests pass.
- Controlled graph, explorer, and hybrid cohorts are supported; raw results
  remain under ignored `evaluation/results/`.

Focused codebase-memory tests pass: 476/476.

Existing integration artifact:

- `integration/codebase-memory-mcp.patch`
- `integration/README.md`

## Priority order

Work tasks in this order unless user requests a narrower task:

1. Finish the grammar dialect policy and label compatibility fixtures.
2. Cover universal syntax gaps only where that policy allows.
3. Improve error recovery and Tree-sitter query coverage.
4. Finish full integration-patch regeneration automation.
5. Package and publish the first release.
6. Add parser performance, stress, and fuzzing gates.

---

## Task 1: Resolve GSC include paths

Status: implemented in `integration/codebase-memory-mcp.patch`. Runtime roots,
aliases, extensions, and case handling are configured through
`.codebase-memory.json`; see `integration/example.codebase-memory.json`.

### Problem

Grammar extracts `#include` paths correctly, but codebase-memory resolves only
two of 336 directives in current source layout. GSC uses game paths rather
than repository-relative paths.

Examples:

- `maps\mp\gametypes\_script`
- `JumpMod\_util`
- `jh\_maptools`

Repository contains multiple roots such as `cod2/` and `shared/`, plus
compatibility aliases. Resolver must understand runtime overlay rules.

### Work

- Locate generic import normalization and module resolution in
  `codebase-memory-mcp/src/pipeline/` and `internal/cbm/`.
- Preserve raw GSC path from the `preproc_include.path` field.
- Normalize backslashes to slash-separated module components.
- Resolve paths case-insensitively, matching CoD2 filesystem semantics where
  appropriate.
- Add optional `.gsc` extension during lookup.
- Model source roots and aliases explicitly. Do not hard-code project-specific
  paths into generic resolution without a configuration mechanism.
- Define precedence when multiple source roots expose the same module and when
  aliases converge on one namespace.
- Keep unresolved stock-game includes as external imports instead of linking
  them to an arbitrary same-name module.

### Tests

- Direct `maps\mp\...` include.
- `JumpMod\...` alias.
- `jh\...` compatibility alias.
- Mixed path case.
- Missing target.
- Two valid targets with same leaf filename.
- Include target present only in shared source.
- Include target overridden by CoD2-specific source.

### Acceptance

- Every include whose target exists in indexed source resolves to correct
  module.
- Missing stock-game includes remain unresolved and non-fatal.
- No resolution based only on leaf filename when path is available.
- End-to-end corpus reports no incorrect cross-root `IMPORTS` edges.

---

## Task 2: Resolve path-qualified calls accurately

Status: implemented in `integration/codebase-memory-mcp.patch`. GSC calls retain
receiver, raw module path, leaf name, thread state, and indirect-call metadata;
resolution now follows local, included-module, unique-name precedence without
guessing among duplicate definitions.

### Problem

Current extraction reduces `JumpMod\_checkpoints::hastrigger` to leaf name
`hastrigger`. This enables some graph edges but loses module identity.

Corpus contains:

- 7,104 definitions.
- 3,984 unique definition names.
- 928 duplicated definition names.
- Nine separate `hastrigger` definitions.

Leaf-only matching can become ambiguous or wrong.

### Work

- Preserve three values for every call:
  - receiver/object, when present;
  - raw module path, when present;
  - function leaf name.
- Resolve qualified calls through same normalized module resolver from Task 1.
- Resolve unqualified calls in this order:
  1. current file;
  2. explicitly included modules;
  3. unique project-wide name;
  4. unresolved when still ambiguous.
- Keep `thread` and object-call flags as metadata if graph schema supports it.
- Support direct, object, threaded, object-threaded, and indirect
  `[[expression]]()` calls.
- Remove or narrow GSC leaf-name fallback in
  `internal/cbm/extract_calls.c` after path-aware resolution works.

### Tests

- Two modules defining same function name.
- Qualified call selects correct module.
- Local function shadows included function.
- Object-qualified call:
  `self JumpMod\_checkpoints::hastrigger(trig)`.
- Threaded qualified call.
- Unqualified ambiguous call stays unresolved.
- Indirect call is captured without inventing target.

### Acceptance

- `get_code_snippet` reports correct qualified callees.
- `trace_path` reaches correct definition without manual leaf-name guessing.
- Duplicate names do not create arbitrary edges.
- Existing direct/local call tests remain green.

---

## Task 3: Add end-to-end MCP corpus gate

Status: implemented and verified by `mise run test:codebase-memory`. The task
uses an isolated temporary source snapshot, cache, database, and logs without
modifying `CBM_ROOT` or user cache.

### Problem

Unit extraction passes, but graph behavior needs a repeatable real-corpus gate.
Current production test was manual and used temporary directories.

### Work

- Add TOML-managed task to `mise.toml`, for example:
  `test:codebase-memory`.
- Accept external checkout through `CBM_ROOT`; do not clone during default
  offline checks.
- Build patched MCP using all available make jobs.
- Index a GSC-only fixture tree or a configured external checkout with an
  isolated `CBM_CACHE_DIR`.
- Query graph counts and representative symbols.
- Keep generated database and logs outside repository.
- Print concise summary only.

### Required assertions

- All `.gsc` files discovered.
- No partial `.gsc` parses.
- Function count equals Tree-sitter definition capture count.
- Representative direct call resolves.
- Representative qualified call resolves.
- Representative include resolves.
- Ambiguous bare function returns suggestions rather than arbitrary target.
- `get_code_snippet` returns exact GSC source range.

### Acceptance

`mise run test:codebase-memory` exits zero and reproduces stable structural
checks without touching user cache.

---

## Task 4: Add differential vscode-cod-gsc fixture harness

Status: implemented in `scripts/test-vscode-cod-gsc.mjs` and exposed as
`mise run test:vscode-cod-gsc`. The pinned baseline records 20/20 valid CoD2
fixtures and keeps universal-only gaps separate.

### Problem

`vscode-cod-gsc` has 84 GSC fixture files, 178 parser tests, and 268 total
test declarations. Current comparison is manual.

### Work

- Add optional task `test:vscode-cod-gsc`.
- Accept checkout through `VSCODE_COD_GSC_ROOT`.
- Pin/report tested upstream commit.
- Parse CoD2 fixture folders separately from universal fixtures:
  - `GscAll.CoD2MP`
  - `GscAll.CoD2MPZkLibcod`
  - `GscAll.CoD2MPCod2x`
- Maintain explicit expected-error allowlist with reason for each file.
- Fail when a new unexpected parse error appears.
- Also fail when an expected-error fixture unexpectedly becomes valid unless
  allowlist is deliberately updated.

### License boundary

`vscode-cod-gsc` uses LGPL-3.0-or-later while this grammar uses MIT.
Do not copy its parser implementation or wholesale test source into this
repository without explicit license review. Prefer:

- external checkout;
- original minimal fixtures;
- links and pinned commit hashes;
- independently written tests describing observable syntax.

### Acceptance

- 20/20 valid CoD2 fixtures pass.
- Intentional invalid CoD2 cast remains expected failure.
- Universal-only gaps reported separately, never mixed into CoD2 score.

---

## Task 5: Decide grammar dialect policy

Status: partially decided. README now states the CoD2-first permissive policy;
fixture-level CoD2, universal, and recovery labels remain to be added.

### Decision needed

Choose and document one:

1. Strict CoD2 syntax.
2. CoD2-first permissive superset.
3. Multi-game grammar with external dialect validation.

Recommended for codebase-memory: CoD2-first permissive syntax. Tree-sitter
should recover and expose structure; separate linter should enforce game
rules.

### Important vscode-cod-gsc rules

Its CoD2 configurations disable:

- global variables at root;
- `foreach`;
- do-while;
- array initializers;
- ternary expressions;
- cvar strings;
- casting.

Current grammar already accepts several of these as a permissive superset.
Document that parse success does not mean valid CoD2.

### Acceptance

- Policy stated in README.
- Corpus tests label CoD2, universal, and recovery-only syntax.
- No feature added solely to increase a misleading aggregate percentage.

---

## Task 6: Cover universal syntax gaps

Status: open and subordinate to Task 5. Cast expressions and `foreach` remain
the clearest known gaps; they must not weaken the CoD2 baseline.

Do only after Task 5 decision.

Candidate features from `vscode-cod-gsc`:

- cast expressions: `(int)1`, nested casts, and cast/operator ambiguity;
- `foreach (value in array)`;
- `foreach (value, key in array)`;
- top-level global assignments;
- incomplete editor expressions for recovery, such as `level.`;
- `breakpoint` keyword behavior.

### Tests

- Valid and invalid cast forms.
- Parenthesized expression versus cast ambiguity.
- Foreach over member, call, and object-call expressions.
- Missing `in`, value, key, or iterable.
- Top-level assignment separated from function definition.

### Acceptance

- New rules create no conflicts or generator warnings.
- Existing 795-file corpus remains 100%.
- CoD2 strictness stays documented as semantic policy, not inferred from
  parser acceptance.

---

## Task 7: Improve error recovery

Status: open. The existing corpus covers valid syntax but does not yet provide
the focused malformed-input and post-error discovery guarantees below.

### Work

- Test missing semicolons without swallowing following function.
- Test unmatched braces, brackets, parentheses, and developer markers.
- Test incomplete member and subscript expressions.
- Test malformed qualified paths.
- Test malformed `#include` and animtree directives.
- Confirm syntax errors retain surrounding function definitions and calls.

### Acceptance

- Invalid file produces localized `ERROR` or `MISSING` nodes.
- Definitions after malformed statement remain discoverable.
- MCP marks file partial but still indexes intact definitions.

---

## Task 8: Expand Tree-sitter queries

Status: partially implemented. Function definitions and direct/qualified calls
are tagged; import tags, useful indirect-call captures, and query-count tests
remain.

### Work

- Add import tag capture for `preproc_include`.
- Add captures for indirect calls where useful.
- Verify direct, qualified, object, and threaded calls produce expected tags.
- Add highlights for fields, paths, directives, function definitions,
  parameters, event keywords, and invalid/recovery constructs.
- Keep query node names aligned with codebase-memory language spec.

### Acceptance

- Query tests assert definition, call, and include capture counts.
- Query changes do not duplicate captures for same call.
- `tree-sitter tags` or equivalent consumer sees functions and references.

---

## Task 9: Make integration patch reproducible

Status: partially implemented. The patch applies cleanly to `7d6cdb2`, the
end-to-end gate is repeatable, and `vendor:check`/`vendor:sync` cover the three
vendored grammar files. Regenerating the complete integration patch is still a
reviewed manual step.

### Work

- Add TOML task accepting `CBM_ROOT`.
- Run `mise run generate`.
- Copy only:
  - `src/parser.c`;
  - `src/tree_sitter/parser.h`;
  - `LICENSE`.
- Update GSC wrapper, enum, language spec, discovery, manifest, tests, and
  documentation count.
- Run `git diff --check` and `git apply --check` against clean upstream
  worktree.
- Regenerate `integration/codebase-memory-mcp.patch`.

### Acceptance

- Patch applies cleanly to documented upstream commit.
- Generated parser ABI is supported by vendored Tree-sitter runtime.
- License/security grammar checks pass.
- No unrelated files staged or included.

---

## Task 10: Add CI around mise.toml

Status: implemented for public offline checks. CI installs the locked mise
toolchain, runs grammar and evaluation tests, rejects generated parser drift,
and compiles the C parser with warnings as errors. External licensed/private
corpus gates remain opt-in by design; dedicated query-count tests remain Task 8.

### Work

- Install tools from `mise.lock`.
- Run `mise run generate`.
- Fail on generated parser drift.
- Run `mise run test`.
- Run optional configured corpus tasks when fixture repositories are present.
- Compile generated parser with C compiler.
- Avoid package.json unless a binding truly requires Node package metadata.

### Acceptance

- Clean clone passes using documented mise commands.
- Tool versions stay locked.
- CI catches grammar, generated-source, and query regressions.

---

## Task 11: Package and release

Status: partially prepared. C binding metadata is present and the changelog now
defines semantic-versioning policy. The first tag and release artifact remain
open.

### Work

- Keep C binding mandatory for codebase-memory.
- Decide whether Node/Python/Rust bindings are wanted; do not add unused
  boilerplate.
- Confirm `tree-sitter.json` metadata and repository URL.
- Add semantic version and changelog policy.
- Tag first release only after path resolution and end-to-end MCP gate.

### Acceptance

- Downstream can vendor generated C parser without Node.js.
- Release tarball contains license, parser, header, queries, and metadata.
- Version bump documents AST-breaking versus additive changes.

---

## Task 12: Performance and robustness

Status: open. Agent lookup benchmarks do not replace parser throughput,
stress, or fuzz testing.

### Work

- Record parse throughput for the external CoD2 corpus.
- Add deeply nested expression/developer-block stress cases.
- Fuzz tokenizer/parser with bounded input and timeout.
- Test very large generated GSC file.
- Keep scanner-free grammar unless external scanner is clearly necessary.

### Acceptance

- No crash, stack overflow, or unbounded parse behavior.
- Corpus throughput does not materially regress without documented reason.

---

## Verification commands

```sh
mise install
mise run generate
mise run test
mise run check
mise run eval:check
```

Optional external corpus:

```sh
GSC_ROOT=/path/to/gsc mise run test:external
ZPAM3_ROOT=/path/to/zpam3 mise run test:zpam3
```

Upstream integration:

```sh
git apply /absolute/path/to/tree-sitter-gsc/integration/codebase-memory-mcp.patch
make -f Makefile.cbm -j"$(nproc)" test-par
```

## Agent handoff rules

- Read nearest `AGENTS.md` before edits.
- Use `mise.toml` and `mise.lock` as tool/task source of truth.
- Commit generated parser changes with grammar changes.
- Never edit generated external runtime trees as source.
- Preserve unrelated untracked work, including `tools/`.
- Do not commit unless user requests it.
- Every commit must use `22911399+Cjdcoy@users.noreply.github.com`. Verify the
  effective Git identity before committing; never use personal or corporate
  mailbox addresses.
- Report syntax coverage, structural extraction, and graph resolution as
  separate metrics.
- Never describe parser as linter replacement.

## Definition of done

GSC support is production-ready for codebase-memory when:

- external CoD2 corpus remains 100% parseable;
- CoD2 reference fixtures pass with explicit expected-error list;
- every resolvable include links to correct module;
- path-qualified calls link to correct duplicate-safe target;
- direct/local calls retain existing behavior;
- production MCP indexes corpus with no partial GSC files;
- representative search, snippet, and trace queries pass automatically;
- integration patch is reproducible and cleanly applies upstream.
