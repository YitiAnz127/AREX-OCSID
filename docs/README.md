# Documentation

This index separates current domain-collection facts from retained upstream
(AREX-Skill / DisCo) material.

## Current project documents

| Document | Scope |
| --- | --- |
| [Root README](../README.md) | Current project scope, validation, and CLI boundary |
| [Chinese README](../README.zh-CN.md) | Chinese project overview |
| [Skill collection](../skills/README.md) | Live router and repository-skill contract |
| [Repository catalog](repository-catalog.md) | Current 109-root coverage by family |
| [Central repository index](imported-repo-skills.md) | All 109 records, origin class, and declared license |
| [Installation](installation.md) | Local validation and CLI build |
| [安装说明](installation.zh.md) | 中文本地验证与 CLI 构建 |
| [Refreshing skills](refreshing-repo-skills.md) | Current import and rebuild commands |
| [刷新技能](refreshing-repo-skills.zh.md) | 中文导入与重建说明 |
| [选择性技能改进 Pilot](ocsid-rsi-pilot.zh.md) | 真实执行、私有判定与固定诊断策略的当前用法和边界 |

## Retained upstream documents

The following files describe inherited upstream (DisCo / AREX-Skill) authoring machinery.
They remain useful for CLI development, but their references to the original
AREX publication or full repository collection are not measurements of this
domain subset:

- [OCSID workflows](ocsid-workflows.md)
- [OCSID workflows (Chinese)](ocsid-workflows.zh.md)
- [OCSID meta skills](ocsid-meta-skills.md)
- [OCSID meta skills (Chinese)](ocsid-meta-skills.zh.md)
- [Architecture](architecture.md)
- [Architecture (Chinese)](architecture.zh.md)
- [CLI README](../cli/README.md)
- [Contribution guide](../CONTRIBUTING.md)

For current counts, always use
`skills/repositories/repo-skills-router/references/index/build-metadata.json`.
For current membership, use `assignments.jsonl`. Do not use upstream badge
counts or retained benchmark text as evidence of this checkout's scope.
