# 刷新 Repository Skills

本文只描述当前文件夹内实际存在的工具。

## 检查当前一致性

```powershell
python scripts/rebuild_router.py
```

默认模式不写文件，只比较预期 router、索引与 live 文件。

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

- `cli/packages/coding-agent/src/disco/skills/verify-repo-skill/scripts/update_repo_skills_router.mjs`
- `cli/packages/coding-agent/src/disco/skills/verify-repo-skill/scripts/import_repo_skill.mjs`
- `cli/packages/coding-agent/src/disco/skills/verify-repo-skill/scripts/build_repo_skills_collection.mjs`

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

当前 Python 重建器从 routing metadata 生成中央 identity 记录，不会恢复上游
commit。因此现有 109 条记录的 `source_commit` 都是 null。在补齐经过验证的来源
证据前，不应把刷新结果描述为 commit-pinned。
