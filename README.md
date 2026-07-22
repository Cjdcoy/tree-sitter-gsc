# tree-sitter-gsc

Tree-sitter grammar for Call of Duty GSC, initially targeting Call of Duty 2.

## Development

Tool versions and tasks live in `mise.toml`.

```sh
mise install
mise run generate
mise run test
CBM_ROOT=/path/to/codebase-memory-mcp mise run test:codebase-memory
VSCODE_COD_GSC_ROOT=/path/to/vscode-cod-gsc mise run test:vscode-cod-gsc
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

Future-agent tasks and measured integration gaps live in
[`FUTURE_WORK.md`](FUTURE_WORK.md).

## Initial language coverage

- Functions, parameters, blocks, and control flow
- Direct, object, threaded, qualified, and indirect function calls
- Includes and animtree preprocessor directives
- Arrays, vectors, localized strings, cvar strings, and animation references
- Developer blocks and GSC comments

## License

MIT
