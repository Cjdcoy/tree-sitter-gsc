# GSC agent evaluation

This directory contains a small, provider-neutral harness for comparing an
agent using `codebase-memory-mcp` with the same agent using ordinary text
exploration.

The included suite is intentionally a **smoke test**, not evidence that the
graph improves agent performance. Its tiny repository has independently
checkable answers and catches broken prompts, result capture, scoring, and tool
condition leakage. Performance claims should use a separate suite built from a
pinned, real GSC repository and multiple repetitions per condition.

## Why Node.js

The grammar already pins Node through `mise` and uses dependency-free ESM
scripts for the codebase-memory integration gate. The harness therefore uses
Node's standard library and emits plain JSON. Statistical analysis can be added
later in Python without coupling the runner to Python packaging.

## Workflow

Validate the suite and scorer:

```sh
mise run eval:check
```

Generate a prompt for one condition:

```sh
node scripts/gsc-agent-eval.mjs prompt graph
node scripts/gsc-agent-eval.mjs prompt explorer
```

The generated prompt excludes the oracle. Give the target repository and prompt
to the agent, save its single JSON response, and score it:

```sh
node scripts/gsc-agent-eval.mjs score /path/to/run.json
```

Compare any number of runs:

```sh
node scripts/gsc-agent-eval.mjs compare \
  /path/to/graph-1.json /path/to/explorer-1.json
```

Each run records its condition, model, repository revision, wall time, token
counts, and per-task tool calls. A run is marked `condition_valid: false` when
the recorded tools cross the Graph/Explorer boundary. Quality is scored only
from structured, independently checkable observations; the prose answer remains
available for blind human or LLM judging.

`test/fixtures/agent-eval/scorer-pass.json` is scorer test data. It is not a
benchmark result.

## Next suite

The first real suite should use a pinned snapshot of a substantial CoD2 GSC
repository and contain 20–30 tasks split across definition discovery, call and
include tracing, exact retrieval, subsystem understanding, and negative or
ambiguous lookups. Run each condition at least five times with the same model,
prompt, context limit, and time limit.
