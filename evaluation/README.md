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

## Controlled zPAM3 benchmark

The benchmark runner isolates Codex configuration and authentication, builds
and indexes the pinned local `codebase-memory-mcp` fork, audits the
model-visible prompt and MCP inventory, captures raw JSONL events, enforces the
strict 20-task response schema, and compares actual tool events with the
response's self-reported tool names. It never invokes a model during
`preflight` or `--dry-run`.

The graph condition enables only the committed graph-tool allowlist and sets
that server's `default_tools_approval_mode` to `approve`. This is intentional:
`codebase-memory-mcp` conservatively marks graph reads as potentially
destructive because corrupt-cache recovery can quarantine files, while the
benchmark uses `approval_policy = "never"` and an isolated disposable cache.
The controller invalidates a graph run that has no successful evidence-bearing
graph call and classifies approval/transport cancellation as infrastructure
failure.

Run the no-spend checks:

```sh
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
  --seed zpam3-v1-sol56-xhigh \
  --dry-run
```

Create and inspect the paid smoke pair:

```sh
node scripts/run-gsc-agent-benchmark.mjs run \
  --suite evaluation/zpam3-v1.json \
  --corpus /path/to/zpam3 \
  --cbm-root /path/to/codebase-memory-mcp \
  --model gpt-5.6-sol \
  --reasoning-effort xhigh \
  --repetitions 5 \
  --seed zpam3-v1-sol56-xhigh \
  --smoke-only
```

If the smoke artifacts are valid and no runner, suite, schema, prompt, binary,
or source input changed, continue the same cohort:

```sh
node scripts/run-gsc-agent-benchmark.mjs run \
  --resume \
  --cohort-dir evaluation/results/zpam3/<cohort-id> \
  --suite evaluation/zpam3-v1.json \
  --corpus /path/to/zpam3 \
  --cbm-root /path/to/codebase-memory-mcp \
  --model gpt-5.6-sol \
  --reasoning-effort xhigh \
  --repetitions 5 \
  --seed zpam3-v1-sol56-xhigh
```

Run only the hybrid condition, with both graph and ordinary explorer tools
enabled, without launching new graph-only or explorer baselines:

```sh
node scripts/run-gsc-agent-benchmark.mjs run \
  --suite evaluation/zpam3-v1.json \
  --corpus /path/to/zpam3 \
  --cbm-root /path/to/codebase-memory-mcp \
  --model gpt-5.6-sol \
  --reasoning-effort xhigh \
  --repetitions 5 \
  --seed zpam3-v1-sol56-xhigh-hybrid \
  --hybrid-only \
  --smoke-only
```

Resume that hybrid-only cohort with the same arguments plus `--resume` and
`--cohort-dir`. The controller rejects a hybrid run unless at least one
evidence-bearing graph call and one ordinary explorer call both succeed. Any
comparison with an earlier explorer cohort is descriptive and unpaired because
the explorer baseline is not rerun.

Rebuild the aggregate report at any time:

```sh
node scripts/run-gsc-agent-benchmark.mjs summarize \
  evaluation/results/zpam3/<cohort-id> \
  --suite evaluation/zpam3-v1.json
```

Each attempt is finalized by an atomic directory rename and retains its prompt,
events, stderr, final response, controller-owned run record, tool audit, score,
and invalidation reasons. `evaluation/results/` is intentionally ignored.

### Latest validated public cohorts

The corrected five-pair zPAM3 cohort produced 0.997 mean weighted score and 98%
exact task accuracy for graph-only, versus 0.996 and 99% for explorer-only.
The five-run hybrid cohort also scored 0.997 with 98% exact accuracy, while
using materially more total tokens than explorer-only. These results measure
the pinned public corpus and runner configuration; they are not general model
benchmarks. Raw cohorts remain local and ignored, while manifests and reports
can be regenerated with the commands above.
