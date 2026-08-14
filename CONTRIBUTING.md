# Contributing

## Development

Install the locked tools and run the public checks:

```sh
mise install
mise run check
mise run eval:check
```

Grammar changes must include corpus coverage and the regenerated
`src/parser.c`, `src/grammar.json`, and `src/node-types.json`. CI rejects drift
in those generated files and compiles the C parser with warnings as errors.

Optional integration gates use existing external checkouts:

```sh
CBM_ROOT=/path/to/codebase-memory-mcp mise run test:codebase-memory
VSCODE_COD_GSC_ROOT=/path/to/vscode-cod-gsc mise run test:vscode-cod-gsc
ZPAM3_ROOT=/path/to/zpam3 mise run test:zpam3
```

## Pull requests

- Branch from `main` and use a focused topic branch.
- Keep generated sources in the same commit as their grammar change.
- Explain whether a syntax change is CoD2 behavior or permissive compatibility.
- Keep private corpora, raw benchmark runs, credentials, and machine-specific
  paths out of commits.
- Do not copy LGPL-licensed `vscode-cod-gsc` implementation or fixtures into
  this MIT repository; use an external checkout and independently written tests.

`main` requires the `test` check, linear history, and resolved review
conversations. Squash merge is the supported merge strategy.
