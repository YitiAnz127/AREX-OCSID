# 刷新 Repository Skills

本文只描述当前文件夹内实际存在的工具。

## 检查当前一致性

```powershell
python scripts/rebuild_router.py
```

默认模式不写文件，只比较预期 router、索引与 live 文件，并报告能保留多少来源
信息：

```text
provenance: 109 repository record(s), 38 pinned to a source commit, 71 unpinned
(source_commit null), 109 carried over from skills/repositories/repo-skills/repository-index.jsonl, 38 with a repo-provenance.md block
confidence: 0 assignment(s) from routing entries, 127 preserved from
skills/repositories/repo-skills-router/references/index/assignments.jsonl, 0 defaulted in legacy mode
```

`source_commit` 只能是完整的 40 位十六进制 commit，`source_url` 只能是 GitHub
仓库地址；已记录的值不符合该契约时会被报告并丢弃，而不是照抄。

## confidence 与 routing decision

confidence 是分类证据，不是生成时补的默认值。经过验证的导入器/更新器契约把它
留在中央 assignment 索引与外部分类决策产物里，绝不写进技能的运行期 metadata。
重建器遵循同一优先级：

```powershell
python scripts/rebuild_router.py --routing-entry <handoff.json> --confidence-mode strict
```

- `--routing-entry <文件>`（可重复）提供经过验证的外部分类交接文件，与上游
  `update_repo_skills_router.mjs` 消费的是同一种产物：
  `{"skill_id": "...", "repo_id": "...", "assignments": [{"area": "...",
  "family": "...", "confidence": "high", "confidence_basis": "committed"}],
  "source_url": "...", "source_commit": "<40-hex>", "source_skill_root": "...",
  "legacy_repo_id": "..."}`。其中的 `repo_id` 与 `(area, family)` 集合会与
  `references/repo-routing-metadata.json` 逐项校验；重复 `skill_id`、未知技能或
  归属集合不一致都会直接报错。
- `--confidence-mode strict` 要求每条归属都有已记录的 confidence：要么来自交接
  文件，要么是 metadata 里显式写的值。既有索引行在 strict 下**刻意不被当作
  证据**，因为那一行本身可能只是 legacy 默认值。需要保留历史上「缺省即 high」
  的行为时用 `--confidence-mode legacy`（默认），它会打印显式警告。
- `--source-index <文件>` 与 `--source-assignments <文件>` 指定用于保留身份、
  来源、别名与已记录 confidence 的先验记录，默认都取 live 文件。

`--flag=value` 与 `--flag value` 等价；未知参数或缺值参数一律报错，不再被静默
忽略。

## 在隔离目录查看生成结果

```powershell
python scripts/rebuild_router.py --output-dir <目录>
```

该模式只写指定目录，不修改
`skills/repositories/repo-skills/repository-index.jsonl`。

## 重建 live router

```powershell
python scripts/rebuild_router.py --write-live
```

该命令更新 live router，并同步根 repository index。taxonomy 从 live router
读取；若修改 taxonomy，必须同步全部技能的 taxonomy hash 和 CLI 的空模板。

## 导入预设第三方技能

导入器需要单独准备源目录：

```powershell
python scripts/import_thirdparty.py --source-root <源目录> --dry-run
python scripts/import_thirdparty.py --source-root <源目录>
python scripts/rebuild_router.py --write-live
```

完整计划预期包含 `SciAgent-Skills`、`computational-chemistry-agent-skills`、
`DrugClaw` 和 `protein-design-skills`。允许只提供部分源；缺失 cluster 会被报告并
跳过，已有目标也会被跳过。
对新导入的根技能和扁平化子技能，导入器会保留 `agents`、`assets`、`models`、
`references` 与 `scripts` 配套目录。

修改 taxonomy 后，先确保文件为 UTF-8、LF 且末尾有换行，再对精确文件字节计算
SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 skills/repositories/repo-skills-router/references/index/taxonomy.json
```

把哈希同步到所有根技能的 `references/repo-routing-metadata.json`、
`cli/packages/coding-agent/src/core/repo-skills-library-manager.ts`，以及三个文件：

- `cli/packages/coding-agent/src/ocsid/skills/verify-repo-skill/scripts/update_repo_skills_router.mjs`
- `cli/packages/coding-agent/src/ocsid/skills/verify-repo-skill/scripts/import_repo_skill.mjs`
- `cli/packages/coding-agent/src/ocsid/skills/verify-repo-skill/scripts/build_repo_skills_collection.mjs`

随后把 taxonomy 的精确字节复制到 CLI bundled 空模板。分别运行
`update_repo_skills_router.test.ts`、import/build tests、
`repo-skills-library-manager.test.ts` 和 `export_repo_skills_to_agent.test.ts`，最后重建
live router 与 CLI。目前没有一条命令能自动完成整套迁移。

## 修改后验证

```powershell
python scripts/rebuild_router.py
python -m unittest scripts.tests.test_domain_scripts -v

cd cli
npm run typecheck
npm run test:examples
npm run verify:provenance
npm run verify:rpiv-todo-contract
npm run verify:package
```

若修改 CLI taxonomy 或 bundled skills，还应运行 repository manager、importer
和 collection builder 的定向 Vitest。

## 来源边界

重建器只保留已经记录下来的来源信息，绝不编造。repository 记录按上游优先级构造
（交接文件 > 既有索引行 > `references/repo-provenance.md` > 派生值），因此导入时
记录过的 commit 会在下次重建时进入 `repository-index.jsonl`，而不是被重置为 null。

仍然缺失的是从未被采集过的证据：

- 109 条记录中有 71 条仍是 `source_commit: null`。它们的 provenance 块记录的是
  `"commit": null`（或根本没有该块），重建器会把它们报告为 unpinned。在该计数降
  到 0 之前，不应把刷新结果描述为 commit-pinned。
- 所有记录的 `source_skill_root` 仍为 null：现存 `repo-provenance.md` 块都没有
  `generated_skill.root`。由 `import_thirdparty.py` 新写入的导入会包含该字段。
- `import_thirdparty.py` 只在导入的源目录位于 git work tree 内时记录源 commit，
  否则记录 null，而不是猜测。
