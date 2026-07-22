# codebase-memory-mcp integration

`codebase-memory-mcp.patch` adds GSC discovery, vendored parser sources,
function/call/include extraction, configured runtime-overlay resolution,
grammar metadata, tests, and language-count documentation to
`DeusData/codebase-memory-mcp`.

GSC call resolution preserves receiver, raw module path, function leaf, thread,
and indirect-call state. Qualified calls use the configured overlay resolver;
unqualified calls resolve local definitions, then included modules, then only a
project-wide unique name. Ambiguous and runtime-indirect targets remain unresolved.

Apply from a clean checkout:

```sh
git apply /home/dcoy/work/perso/cod2-serv/tree-sitter-gsc/integration/codebase-memory-mcp.patch
make -f Makefile.cbm -j"$(nproc)" test-par
```

Run the repeatable end-to-end corpus gate from this repository. `CBM_ROOT`
must point to an upstream Git checkout whose `HEAD` accepts the patch; the task
archives that revision, patches and builds the temporary copy, then indexes the
fixture with isolated cache and logs:

```sh
CBM_ROOT=/path/to/codebase-memory-mcp mise run test:codebase-memory
```

The gate checks complete GSC discovery and parsing, Tree-sitter/MCP function
count parity, direct and qualified calls, raw module-path metadata, qualified
`trace_path` traversal, includes, ambiguous-name suggestions, and exact
`get_code_snippet` source ranges. It does not modify `CBM_ROOT` or user cache.
Set `CBM_KEEP_TMP=1` to retain temporary build and logs.

For multi-root CoD2 projects, copy `example.codebase-memory.json` to the indexed
repository root as `.codebase-memory.json`, then adapt source roots and aliases
to the runtime layout. Source-root order defines duplicate-module precedence;
lookup is case-insensitive and tries the optional `.gsc` extension.

The patch vendors `src/parser.c`, `src/tree_sitter/parser.h`, and `LICENSE`
from this repository. Regenerate with `mise run generate` before refreshing
the patch after grammar changes.
