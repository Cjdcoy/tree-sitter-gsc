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

## zPAM3 suite

`zpam3-v1.json` is the public real-world suite. It pins
[`eyza-cod2/zpam3`](https://github.com/eyza-cod2/zpam3) commit
`83285ae8d2ba65640cf46318feade49463652a06` and contains 20 tasks across
definition discovery, call tracing, exact retrieval, module resolution, and
negative or ambiguous lookups.

Prepare the external corpus without copying zPAM source into this repository:

```sh
git clone https://github.com/eyza-cod2/zpam3.git /path/to/zpam3
git -C /path/to/zpam3 checkout 83285ae8d2ba65640cf46318feade49463652a06
ZPAM3_ROOT=/path/to/zpam3 mise run test:zpam3
cp evaluation/zpam3.codebase-memory.json /path/to/zpam3/.codebase-memory.json
codebase-memory-mcp cli index_repository \
  --repo-path /path/to/zpam3 \
  --name zpam3-gsc-benchmark-83285ae \
  --mode full
```

Validate the suite or generate condition prompts with:

```sh
node scripts/gsc-agent-eval.mjs validate --suite evaluation/zpam3-v1.json
node scripts/gsc-agent-eval.mjs prompt graph --suite evaluation/zpam3-v1.json
node scripts/gsc-agent-eval.mjs prompt explorer --suite evaluation/zpam3-v1.json
```

The zPAM3 repository does not currently declare a software license. This
benchmark therefore references and clones the upstream repository only for
validation; it does not vendor or quote zPAM source. The committed suite stores
only the repository URL, pinned revision, symbol names, paths, line numbers, and
structural relationships.

Run each condition at least five times with the same model, prompt, context
limit, and time limit before drawing performance conclusions.
