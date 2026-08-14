# tree-sitter-gsc

[![CI](https://github.com/Cjdcoy/tree-sitter-gsc/actions/workflows/ci.yml/badge.svg)](https://github.com/Cjdcoy/tree-sitter-gsc/actions/workflows/ci.yml)

Tree-sitter grammar for Call of Duty GSC, initially targeting Call of Duty 2.

The grammar is CoD2-first: the committed corpus and compatibility gates define
the supported baseline. Some syntax from other GSC dialects is accepted as a
permissive superset, but parse success alone does not mean that syntax is valid
for CoD2. The remaining dialect-policy work is tracked in
[`FUTURE_WORK.md`](FUTURE_WORK.md).

## Development

Tool versions and tasks live in `mise.toml`.

```sh
mise install
mise run check
mise run eval:check
CBM_ROOT=/path/to/codebase-memory-mcp mise run test:codebase-memory
VSCODE_COD_GSC_ROOT=/path/to/vscode-cod-gsc mise run test:vscode-cod-gsc
ZPAM3_ROOT=/path/to/zpam3 mise run test:zpam3
```

Optional external corpus:

```sh
GSC_ROOT=/path/to/gsc mise run test:external
```

`test:codebase-memory` uses an existing upstream Git checkout, applies the
integration patch to a temporary snapshot, builds it, and indexes a small GSC
fixture with isolated cache and logs. It never modifies `CBM_ROOT` or user cache.

`test:vscode-cod-gsc` compares all 84 external fixtures at pinned commit
`717759afcd20f02c697105f82565fd2cabdd9b24`. It reports CoD2 folders separately
and enforces an explicit expected-error allowlist in both directions. No
LGPL-3.0-or-later fixture or parser source is copied into this MIT repository.

Generated `src/parser.c`, `src/grammar.json`, and `src/node-types.json` are
committed so downstream C projects can vendor the grammar without Node.js.

The public zPAM3 evaluation suite and controlled graph/explorer/hybrid runner
are documented in [`evaluation/README.md`](evaluation/README.md). Raw run
artifacts stay under the ignored `evaluation/results/` directory.

Future-agent tasks and measured integration gaps live in
[`FUTURE_WORK.md`](FUTURE_WORK.md).

## Contributing and security

Changes go through pull requests to protected `main`; CI must pass and review
conversations must be resolved. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
test matrix and corpus-license boundary. Report vulnerabilities privately as
described in [`SECURITY.md`](SECURITY.md).

## Initial language coverage

- Functions, parameters, blocks, and control flow
- Direct, object, threaded, qualified, and indirect function calls
- Includes and animtree preprocessor directives
- Arrays, vectors, localized strings, cvar strings, and animation references
- Developer blocks and GSC comments

## License

MIT
