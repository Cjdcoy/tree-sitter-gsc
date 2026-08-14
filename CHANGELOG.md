# Changelog

This project follows [Semantic Versioning](https://semver.org/). AST node or
field removals and incompatible renames require a major version bump; additive
syntax and query captures are minor changes; compatible fixes are patches.

## Unreleased

### Added

- Repeatable codebase-memory integration and vscode-cod-gsc compatibility gates.
- Public zPAM3 corpus and controlled agent-evaluation harness.
- GitHub Actions CI, generated-source drift checks, C compilation, Dependabot,
  and protected-branch governance.

### Changed

- GSC include and qualified-call integration now uses configured runtime roots,
  aliases, duplicate-safe resolution, and preserved call metadata.

## 0.1.0 - 2026-07-22

### Added

- Initial CoD2-focused GSC grammar, generated C parser, queries, corpus tests,
  and codebase-memory integration patch.
