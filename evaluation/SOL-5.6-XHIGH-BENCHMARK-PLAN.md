# zPAM3 graph-vs-explorer benchmark handoff

Status: ready for an implementation/evaluation agent

Handoff agent: run this implementation task with `gpt-5.6-sol` at `xhigh`

Benchmark model: `gpt-5.6-sol`

Reasoning effort: `xhigh`

Benchmark suite: `evaluation/zpam3-v1.json`

Required valid repetitions: 5 per condition

## Mission

Build the missing local benchmark runner, validate it without spending model
tokens, then run a controlled comparison of:

- `graph`: Codex may discover code only through the
  `codebase-memory-mcp` graph tools.
- `explorer`: Codex may discover code through ordinary file reads and text
  search, with `codebase-memory-mcp` unavailable.

Use the same `gpt-5.6-sol` model, `xhigh` reasoning effort, task prompt,
source snapshot, sandbox, timeout, and output contract in both conditions.
Produce auditable raw artifacts and a concise result report. Do not push
branches or open pull requests.

The work is complete only when the runner is tested, both arms have five valid
runs, the results have been scored and compared, and invalid or retried
attempts are disclosed.

## Scope and authority

You may:

- add or modify local benchmark scripts, schemas, fixtures, documentation, and
  ignored result directories in `tree-sitter-gsc`;
- build the local `codebase-memory-mcp` fork;
- clone or reuse the pinned public zPAM3 source outside the repository;
- create isolated temporary Codex and codebase-memory state;
- execute the paid benchmark after the smoke pair passes.

Do not:

- publish or push anything;
- expose, vendor, or refer to private Jump4life source in public artifacts;
- commit zPAM3 source, because its repository does not currently provide a
  license;
- change the grammar, extractor, resolver, suite questions, or scoring oracles
  during a run cohort;
- silently weaken a task, output schema, tool restriction, or scoring rule to
  make a run pass;
- let a benchmark subject inspect `evaluation/zpam3-v1.json`, scorer fixtures,
  prior runs, or any other oracle-bearing artifact.

If a grammar or graph defect is found, record it for follow-up. Finish or
invalidate the current cohort before changing implementation behavior.

## Pinned baseline

Verify these values rather than assuming that the working copies are still at
them:

- `tree-sitter-gsc`: branch `feat/gsc-agent-integration`, baseline commit
  `b4183a1`.
- `codebase-memory-mcp`: branch `feat/gsc-support`, baseline commit
  `7a33a3e9`.
- zPAM3 repository: `https://github.com/eyza-cod2/zpam3.git`.
- zPAM3 revision: `83285ae8d2ba65640cf46318feade49463652a06`.
- graph project: `zpam3-gsc-benchmark-83285ae`.
- expected corpus gate: 180 `.gsc` files parsed, zero parse failures, and 1,580
  function definitions.
- suite: 20 tasks, with four tasks in each of D1 through D5.

Newer local commits are acceptable only if they are recorded in the cohort
manifest and all preflight gates pass. Never mix commits within a cohort.

Preserve unrelated user changes in every working tree.

## Read first

Read these files before implementing the runner:

1. `evaluation/README.md`
2. `evaluation/zpam3-v1.json`
3. `evaluation/zpam3.codebase-memory.json`
4. `scripts/gsc-agent-eval.mjs`
5. `scripts/test-zpam3.mjs`
6. `mise.toml`

For code discovery, follow the repository `AGENTS.md` priority and use
codebase-memory graph tools first. Shell search is appropriate for the
evaluation JSON, Markdown, CLI help, config, and exact string literals.

## Required deliverables

Implement, at minimum:

1. `scripts/run-gsc-agent-benchmark.mjs`
   - dependency-free Node ESM;
   - uses `child_process.spawn` with an argv array, never a shell command
     string;
   - provides `preflight`, `run`, and `summarize` commands;
   - supports a no-spend `--dry-run`;
   - handles timeouts, signals, partial output, retries, and atomic artifact
     finalization.
2. `evaluation/agent-run.schema.json`
   - strict JSON Schema for the final agent response;
   - consistent with the result shape emitted by
     `gsc-agent-eval.mjs prompt`;
   - requires all 20 task IDs exactly once and rejects additional task IDs.
3. Runner tests and fixtures
   - use a fake `codex` executable or injected process adapter;
   - cover success, malformed JSON, wrong model/revision/condition, timeout,
     nonzero exit, missing tasks, duplicate tasks, actual forbidden tool use,
     self-reported/actual tool mismatch, and oracle-path access;
   - do not call a model.
4. A results layout and aggregate report generator.
5. A short `evaluation/README.md` update containing the exact local commands.

Node is intentional here: the existing harness is dependency-free ESM and the
repository already pins Node through `mise`. This choice is for orchestration;
the parser and codebase-memory implementation remain native C.

Suggested runner interface:

```text
node scripts/run-gsc-agent-benchmark.mjs preflight \
  --suite evaluation/zpam3-v1.json \
  --corpus /path/to/zpam3 \
  --cbm-root /path/to/codebase-memory-mcp

node scripts/run-gsc-agent-benchmark.mjs run \
  --suite evaluation/zpam3-v1.json \
  --corpus /path/to/zpam3 \
  --cbm-root /path/to/codebase-memory-mcp \
  --model gpt-5.6-sol \
  --reasoning-effort xhigh \
  --repetitions 5 \
  --seed zpam3-v1-sol56-xhigh

node scripts/run-gsc-agent-benchmark.mjs summarize \
  evaluation/results/zpam3/<cohort-id>
```

Exact flag names may be adjusted, but the committed help output and README must
be sufficient for another developer to reproduce the cohort.

## Phase 1: establish a clean, recorded baseline

Before changing files:

```sh
git -C /path/to/tree-sitter-gsc status --short --branch
git -C /path/to/tree-sitter-gsc rev-parse HEAD
git -C /path/to/codebase-memory-mcp status --short --branch
git -C /path/to/codebase-memory-mcp rev-parse HEAD
codex --version
codex login status
```

Run the existing gates:

```sh
cd /path/to/tree-sitter-gsc
mise run eval:check
ZPAM3_ROOT=/path/to/zpam3 mise run test:zpam3
CBM_ROOT=/path/to/codebase-memory-mcp mise run test:codebase-memory
CBM_ROOT=/path/to/codebase-memory-mcp mise run vendor:check
```

Also verify:

- the zPAM working tree is at the pinned revision;
- its configured `origin` URL matches the suite target;
- the only permitted corpus change is
  `.codebase-memory.json`, whose bytes must equal
  `evaluation/zpam3.codebase-memory.json`;
- the suite validates and the prompt generator emits no `oracle` values.

Write these facts into the cohort manifest before the first model call.

## Phase 2: build and isolate codebase-memory

Build the local fork and use that binary, not an unrelated installed release:

```sh
cd /path/to/codebase-memory-mcp
make -f Makefile.cbm cbm
```

Expected binary:

```text
/path/to/codebase-memory-mcp/build/c/codebase-memory-mcp
```

Create a unique cohort cache and use the same absolute binary and cache for
indexing and MCP serving:

```text
CBM_CACHE_DIR=<cohort-dir>/cbm-cache
CBM_ALLOWED_ROOT=<absolute-zpam3-root>
CBM_LOG_LEVEL=warn
```

Index only after copying the exact configuration overlay:

```sh
cp /path/to/tree-sitter-gsc/evaluation/zpam3.codebase-memory.json \
  /path/to/zpam3/.codebase-memory.json

/path/to/codebase-memory-mcp/build/c/codebase-memory-mcp \
  cli --json index_repository \
  '{"repo_path":"/absolute/path/to/zpam3","name":"zpam3-gsc-benchmark-83285ae","mode":"full"}'
```

The runner should construct the JSON argument safely rather than interpolate
the example string above.

Use the same binary's one-shot `cli --json <tool> <json_args>` interface to
check the indexed graph before trials. At minimum verify:

- project name and repository path;
- 1,580 function nodes;
- `generateMatchDescriptionDebounced` has six distinct direct callers;
- `addEventListener` has 72 distinct direct caller functions;
- the graph resolves the known path-qualified startup calls covered by D4.

Do not include graph indexing time in the agent task time. Record it separately.

## Phase 3: create a neutral Codex environment

The normal Codex home is not a valid benchmark environment. On this machine it
injects a global instruction that says to prefer graph tools, which biases the
explorer condition.

For every cohort:

1. Create an owner-only temporary benchmark `CODEX_HOME` and use it for every
   Codex command in the cohort. A separate home per condition is also valid if
   both are generated from the same neutral template.
2. Reuse authentication without printing it or committing it.
   - Prefer the existing secure credential mechanism.
   - If file authentication must be made visible to the isolated home, use a
     mode-`0600` link or another minimal mechanism after checking how the
     installed CLI refreshes credentials.
   - Never include `auth.json` contents in logs, manifests, errors, fixtures,
     or command output.
3. Generate a minimal condition-neutral base config. Pass the graph server as
   explicit condition-specific config, or generate two configs that differ
   only by that server.
4. Disable unrelated tools and behavior:
   - web search;
   - apps/connectors;
   - plugins not required by the benchmark;
   - multi-agent tools;
   - memories;
   - hooks;
   - all MCP servers except the explicitly configured graph server in the
     graph condition.
5. Keep the source sandbox read-only and approval policy non-interactive.

Before spending tokens, use `codex debug prompt-input` or the current
equivalent to render the model-visible input. Fail preflight if it contains:

- the global “prefer graph tools” instruction;
- an evaluation oracle;
- a prior-run answer;
- different non-condition instructions between graph and explorer;
- private Jump4life paths or content.

Store a hash and a redacted copy of the neutral prompt prefix for each
condition. The only intended prompt difference is the condition block produced
by the suite harness.

Use `codex mcp list --json` with the benchmark config to verify tool exposure:

- graph: exactly one discovery MCP server, backed by the local fork binary;
- explorer: no codebase-memory MCP server;
- neither arm: context-mode, OpenAI docs, web search, apps, or plugin discovery
  tools.

For the graph arm, set an MCP `enabled_tools` allowlist. It should contain only
read-only graph/status tools needed by the suite, such as:

```text
get_architecture
get_code_snippet
get_graph_schema
index_status
list_projects
query_graph
search_graph
trace_path
```

Do not expose `index_repository` or `search_code` to the benchmark subject.

For the explorer arm, disable the server with the documented
`mcp_servers.<id>.enabled=false` setting rather than relying only on a prompt
instruction.

## Phase 4: implement the Codex process adapter

The installed CLI inspected while writing this plan was `codex-cli 0.145.0`.
The runner must inspect current `codex exec --help` and fail clearly if a
required flag is absent.

The intended invocation shape is:

```sh
codex exec \
  --ephemeral \
  --strict-config \
  --model gpt-5.6-sol \
  --config 'model_reasoning_effort="xhigh"' \
  --config 'approval_policy="never"' \
  --sandbox read-only \
  --cd /absolute/path/to/zpam3 \
  --json \
  --output-schema /absolute/path/to/agent-run.schema.json \
  --output-last-message /absolute/path/to/final.json \
  -
```

Additional condition-specific config values must be passed as discrete argv
entries or written to the isolated benchmark config. Set `CODEX_HOME` to the
isolated directory when launching the process; otherwise the normal user
config and global `AGENTS.md` will contaminate the trial. Do not use
`--dangerously-bypass-approvals-and-sandbox`.

Feed the prompt on stdin. Generate it with:

```sh
node scripts/gsc-agent-eval.mjs prompt <graph|explorer> \
  --suite evaluation/zpam3-v1.json
```

The controller may append only run-owned metadata such as the exact `run_id`.
Apply the same append-only template to both conditions.

For each invocation:

- launch a fresh process with `--ephemeral`;
- never use `resume`, `--last`, or prior response state;
- capture stdout JSONL, stderr, the final response file, start/end timestamps,
  exit status, termination signal, and timeout status;
- parse usage from CLI events when present;
- retain unknown JSONL event types for forward compatibility;
- enforce a configurable timeout, initially 45 minutes per full run;
- on timeout, terminate gracefully, then force termination after a short
  bounded grace period;
- write into an `attempt.tmp` directory and atomically rename it only after
  metadata is finalized.

The controller, not the model, is authoritative for:

- run ID;
- condition;
- requested model;
- requested reasoning effort;
- repository revision;
- CLI version;
- source and codebase-memory commits;
- wall-clock metrics.

Reject a final object that claims different values. Do not silently accept or
rewrite a mismatched condition, model, or revision.

## Phase 5: audit actual tool use

Do not rely only on each answer's self-reported `tool_calls`.

Parse actual tool events from Codex JSONL and canonicalize their names. Record:

- actual tool name;
- timestamp/order;
- arguments with secrets redacted;
- exit/result status;
- task association when it can be established;
- file paths or command text relevant to leakage checks.

The run is invalid if actual events show:

- graph condition: shell execution, text search, or direct file reading used
  for code discovery;
- explorer condition: any codebase-memory graph call;
- either condition: access to the suite, scorer, fixtures, prior results, or
  other oracle-bearing paths;
- a tool call omitted from the model's self-reported tool set;
- an unexpected tool namespace that preflight did not approve.

Self-reported per-answer tool lists are still retained because the existing
scorer consumes them. Add a separate controller-owned tool audit to the
manifest and aggregate report.

Be careful when redacting command arguments: preserve enough information to
audit repository paths and tool policy while removing tokens, keys, cookies,
authorization headers, and credential file contents.

## Phase 6: no-spend runner validation

Before any real model call:

1. Run all existing harness self-tests.
2. Run the new runner tests with a fake Codex process.
3. Run `preflight`.
4. Run `--dry-run` for both conditions.
5. Inspect the rendered argv, MCP inventory, model-visible prompt audit, output
   schema, corpus status, graph invariants, and artifact paths.
6. Run `git diff --check`.

The dry run must prove that both arms request:

- `gpt-5.6-sol`;
- `xhigh`;
- read-only sandbox;
- ephemeral sessions;
- the same source revision;
- the same task prompt outside the condition policy.

## Phase 7: smoke pair

Run one graph attempt and one explorer attempt using the first scheduled pair.
Inspect both before continuing.

A smoke run is valid only if:

- Codex exits successfully before timeout;
- the requested model and `xhigh` effort are confirmed by config and recorded
  events where available;
- the final response passes the strict schema;
- all 20 tasks appear exactly once;
- repository revision matches;
- the actual-tool audit passes;
- `gsc-agent-eval.mjs score` succeeds;
- the corpus is unchanged before and after the attempt.

If the runner, schema, prompt, MCP exposure, scorer, or benchmark configuration
changes after the smoke pair, discard those runs and start a new cohort.
Otherwise the smoke pair may count as repetition 1.

## Phase 8: full cohort

Run five valid independent repetitions per condition. Use paired blocks and a
recorded deterministic schedule:

```text
pair 1: graph, explorer
pair 2: explorer, graph
pair 3: graph, explorer
pair 4: explorer, graph
pair 5: graph, explorer
```

Run sequentially. Parallel model calls would add resource contention and make
latency less interpretable.

Retry only infrastructure failures, such as authentication outages, service
errors, process launch failures, or a clearly corrupted output transport.
Record every failed attempt. Do not retry a completed, validly captured run
merely because its task score is poor.

Five *valid* runs are required per arm. Invalid attempts do not count toward
the five and remain visible in the cohort manifest.

## Artifact layout

Use a timestamped, unique cohort directory:

```text
evaluation/results/zpam3/<cohort-id>/
  manifest.json
  prompt-prefix-audit/
  cbm-cache/
  attempts/
    001-graph/
      metadata.json
      prompt.txt
      events.jsonl
      stderr.txt
      final.json
      run.json
      tool-audit.json
      score.json
    002-explorer/
      ...
  aggregate.json
  report.md
```

Add `evaluation/results/` to `.gitignore` unless an existing rule already
covers it. Raw runs and caches are local by default. Do not commit them without
explicit review. A small sanitized aggregate/report may be proposed for a
later commit.

The manifest must include:

- cohort ID and schema version;
- exact schedule and seed;
- requested model and reasoning effort;
- Codex CLI version;
- source repository URL and revision;
- tree-sitter-gsc and codebase-memory commits plus dirty-state summaries;
- absolute binary path and a SHA-256 hash of the binary;
- graph project, cache identity, index duration, and invariant results;
- prompt and output-schema hashes;
- per-attempt status and invalidation reason;
- environment facts that affect execution, without secrets.

## Scoring and analysis

Score each valid run:

```sh
node scripts/gsc-agent-eval.mjs score <run.json> \
  --suite evaluation/zpam3-v1.json
```

Compare all valid runs:

```sh
node scripts/gsc-agent-eval.mjs compare <run.json>... \
  --suite evaluation/zpam3-v1.json
```

The aggregate report must include, per condition and where useful per D1-D5:

- valid and invalid attempt counts;
- exact task accuracy and mean score;
- median, minimum, maximum, and p95 end-to-end wall time;
- input and output tokens;
- cached/reasoning/total tokens when emitted by the CLI;
- tool call count and tool-name distribution;
- forbidden-tool and oracle-access violations;
- structured-output failure rate;
- paired graph-minus-explorer score and latency differences;
- every task missed in at least one run, grouped by likely failure mode.

With five repetitions per arm, report descriptive results and paired
differences. Do not make strong statistical-significance claims. Distinguish:

- grammar parse failures;
- missing or wrong graph nodes/edges;
- ambiguous or unresolved graph lookup;
- agent tool-routing failure;
- correct evidence with an incorrectly formatted answer;
- scorer/oracle defect;
- ordinary model variance.

Lower latency, token use, or tool count is an improvement only when the final
answer still meets the suite's accuracy and evidence requirements.

## Stop conditions

Stop before further paid calls and report the exact blocker if:

- the model ID or `xhigh` effort cannot be pinned or verified;
- the current CLI lacks required noninteractive, ephemeral, JSONL, or
  structured-output support;
- neutral prompt isolation cannot be demonstrated;
- forbidden tools cannot be disabled or reliably audited;
- the graph project is stale, points to a different corpus, or fails a known
  invariant;
- the source revision or config overlay differs from the suite;
- a benchmark subject can access an oracle-bearing path;
- authentication requires exposing credentials;
- either working tree changes unexpectedly during the cohort;
- the runner needs a material methodology change after valid trials began.

Do not classify ordinary poor model performance as infrastructure failure.

## Final handoff report

Return:

1. Files changed and the local commit, if one was created.
2. Exact validation commands and outcomes.
3. Cohort ID and artifact directory.
4. Five-run aggregate for graph and explorer.
5. Paired differences and D1-D5 breakdown.
6. Invalid/retried attempts and reasons.
7. Actual-tool audit summary.
8. The most likely grammar, extractor, resolver, graph-tool, prompt, or scorer
   improvements, ranked by observed benchmark impact.
9. Anything deliberately left unchanged.
10. Confirmation that nothing was pushed and no private Jump4life content
    entered public artifacts.

## Current OpenAI guidance used by this plan

- Pin the explicit `gpt-5.6-sol` model rather than depending on an alias.
- Set `model_reasoning_effort` explicitly; `xhigh` is supported for demanding
  quality-first work.
- Keep the prompt lean, specify success criteria and tool-routing boundaries,
  and validate on representative tasks.
- Compare task success, evidence completeness, tokens, latency, cost, calls,
  turns, and retries; fewer resources matter only when quality still passes.

References:

- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
