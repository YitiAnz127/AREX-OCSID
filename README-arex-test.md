# arex-test 实现说明

## 1. 项目定位

`arex-test` 是 AREX-Skill 的化学与生命科学领域子集。它包含两部分：

1. 根目录下的领域技能集合与 live router；
2. `cli/` 下派生自 DisCo 0.2.1 的本地 `ocsid` CLI 源码。

这两部分有不同的发布边界：live 集合包含 109 个 repository-skill；CLI npm
包只携带空 router 模板和 taxonomy，不携带这 109 个技能。

## 2. 可验证范围

`skills/repositories/repo-skills-router/references/index/build-metadata.json`
记录：

- 2 个 area；
- 10 个 family；
- 109 个 repository-skill；
- 127 条 taxonomy assignment。

实际目录扫描得到 109 个带根 `SKILL.md` 的 repository-skill，全部有
`references/repo-routing-metadata.json`。中央 repository index 与 router
repository index 字节一致；当前没有重复 skill ID、重复 assignment、缺失目标或
router 内部断链。

repository-skill 树共有 683 个 `SKILL.md`。此外，task-oriented 目录包含：

- FrontierCS：9 个 `SKILL.md`；
- PaperBench：636 个 `SKILL.md`；
- PassNet：6 个 `SKILL.md`。

这些计数来自当前文件夹，不代表上游 AREX-Skill 的完整发布规模。

## 3. taxonomy

当前 taxonomy 只有 Biomedical AI 与 Scientific Computing。Quantum Chemistry
和 Quantum Computing 是两个独立 family：前者处理电子结构、DFT、ab initio
与半经验计算；后者处理量子线路、模拟器与量子算法。

准确的 family 成员以
`skills/repositories/repo-skills-router/references/families/` 和
`assignments.jsonl` 为准。

## 4. 第三方导入

`scripts/import_thirdparty.py` 的 PLAN 定义了 49 个导入根技能，来自四类外部
源目录：

- SciAgent-Skills；
- computational-chemistry-agent-skills；
- DrugClaw；
- protein-design-skills。

这些外部源代码不包含在本仓库的正式输入契约内。运行者必须使用
`--source-root` 或 `AREX_THIRD_PARTY_SKILLS_ROOT` 指定源目录。完整计划需要上述
四个子目录；只提供部分源也是合法的，缺失 cluster 会被报告并跳过。

```powershell
python scripts/import_thirdparty.py --source-root <目录> --dry-run
```

不带 `--dry-run` 时，脚本只创建尚不存在的目标技能；已有目标会跳过。脚本不会
自动重建 router。

## 5. router 重建

`scripts/rebuild_router.py` 从当前 taxonomy、根技能 frontmatter 和 routing
metadata 生成 router 视图及中央索引。

```powershell
# 只读一致性检查，默认行为
python scripts/rebuild_router.py

# 输出到隔离目录，不修改 live index
python scripts/rebuild_router.py --output-dir <目录>

# 显式更新 live router 与 repository-index.jsonl
python scripts/rebuild_router.py --write-live
```

JSON 生成统一使用 UTF-8、LF 与末尾换行，taxonomy 哈希可以被 CLI 的 Node.js
更新器稳定复现。

## 6. CLI 状态

`cli/package.json` 定义本地包 `ocsid@0.2.1`，可执行文件为
`ocsid -> dist/cli.js`，Node.js 要求为 `>=22.19.0`。

CLI 内置 router 是空模板：它包含相同的 2-area/10-family taxonomy，但 repository
和 assignment index 为空。导入或 collection build 时才生成 live membership
页面。

`repo-skills-library-manager.ts` 的默认远端仍是上游
`VectorSpaceLab/AREX-Skill`。因此当前本地领域集合不能通过上游 managed installer
自动获得。根目录的 `install-disco.ps1` 与 `install-disco.sh` 也仍安装
`@arex-skill/disco`，不是 `ocsid`。

## 7. 已知数据边界

- 当前没有 `skills/mcp/`，也没有可运行的 MCP server。
- 109 条 repository index 记录的 `source_commit` 均为 null。
- 50 个第三方导入根使用逻辑 repository ID，并声明未知许可证。这些 ID 形如
  `库名/簇名`（如 `SciAgent-Skills/genomics-bioinformatics`），据此生成的
  `source_url` 可能指向不存在的 GitHub 仓库；`DrugClaw/*`、`ClawBio/ClawBio`
  等则对应真实仓库。逻辑 ID 的 `source_commit` 与 `source_skill_root` 均为 null。
- 另有 10 个 retained AREX 根声明 `NOASSERTION`；这表示未取得明确 SPDX 结论，
  不是已确认的再分发许可。
- `repo-provenance.md` 是描述性来源记录，不等于 commit-pinned 供应链清单。
- `auth.json`、`settings.json` 和 `sessions/` 是本地运行数据，不属于项目能力或文档输入。

## 8. 当前校验命令

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

CLI 完整测试继承了上游的大量跨平台用例。在 Windows 上应区分领域改动的定向测试
与上游平台相关失败，不能只用总失败数判断领域 router 是否一致。
