# OCSID 化学与生物化学技能库

[English](README.md)

本仓库是
[VectorSpaceLab/AREX-Skill](https://github.com/VectorSpaceLab/AREX-Skill)
的领域裁剪版本。当前文件夹保留化学、生物化学、分子科学、制药及相邻生物医学方向的
repository skills，同时包含 OCSID CLI 源码（上游 AREX-Skill CLI（`@arex-skill/disco`）
的改名分支，含本地适配）。

## 当前实际范围

`skills/repositories/` 下的 live router 索引是 repository 根数与归属数的事实源：

- 109 个 repository-skill 根目录
- 127 条 area/family 归属
- 2 个 area、10 个 family
- repository-skill 树内共 683 个 `SKILL.md`，包含根技能和嵌套技能
- 651 个 task-oriented `SKILL.md`：FrontierCS 9、PaperBench 636、PassNet 6

repository-skill 与 task-oriented 两棵树合计 1,334 个 `SKILL.md`；该数不包含
router 入口、CLI 资源和 staging 材料。

| Area | Family | 归属数 |
| --- | --- | ---: |
| Biomedical AI | Clinical Prediction from Health Records | 2 |
| Biomedical AI | Drug Discovery and Development | 15 |
| Scientific Computing | Biomolecular Visualization | 6 |
| Scientific Computing | Genomics and Bioinformatics | 27 |
| Scientific Computing | Materials Informatics | 5 |
| Scientific Computing | Molecular Informatics | 20 |
| Scientific Computing | Molecular Simulation | 14 |
| Scientific Computing | Protein Modeling | 36 |
| Scientific Computing | Quantum Chemistry | 1 |
| Scientific Computing | Quantum Computing | 1 |

归属数不是去重后的仓库数；一个 repository skill 可以属于多个 family。

## 目录结构

```text
OCSID/
├── skills/
│   ├── repositories/
│   │   ├── repo-skills/          # 109 个 live repository-skill
│   │   └── repo-skills-router/   # 生成的 live router 与索引
│   ├── task-oriented/            # FrontierCS、PaperBench、PassNet
│   └── third-party-staging/      # 保留的暂存材料
├── scripts/
│   ├── import_thirdparty.py      # 从外部源目录导入
│   ├── rebuild_router.py         # 检查或重建 router
│   └── tests/                    # 领域脚本回归测试
├── cli/                          # ocsid 0.2.1（上游 CLI 的改名分支）
├── docs/
└── examples/
```

router 的机器可读事实文件为：

- `references/index/taxonomy.json`
- `references/index/repositories.jsonl`
- `references/index/assignments.jsonl`
- `references/index/build-metadata.json`

CLI 只内置同一 taxonomy 的空 router 模板，不会把根目录 109 个技能打进 npm 包。

## 校验技能集合

需要 Python 3.10 或更高版本：

```powershell
python scripts/rebuild_router.py
python -m unittest scripts.tests.test_domain_scripts -v
Get-ChildItem skills/task-oriented -Directory | ForEach-Object { "{0}={1}" -f $_.Name, (Get-ChildItem $_.FullName -Recurse -Filter SKILL.md -File).Count }
```

第一条命令默认只读；若生成文件或根索引过期，返回状态码 1。

第三方导入需要显式提供独立源目录：

```powershell
python scripts/import_thirdparty.py --source-root <s-skills目录> --dry-run
```

正式导入会写入新的 repository-skill，随后必须显式重建 live router：

```powershell
python scripts/import_thirdparty.py --source-root <s-skills目录>
python scripts/rebuild_router.py --write-live
```

使用 `--output-dir <目录>` 可把 router 生成到其他位置，不改动 live
`repository-index.jsonl`。

## CLI 开发

本地包名为 `ocsid`，版本 0.2.1，要求 Node.js 22.19.0 或更高版本。

```powershell
cd cli
npm install
npm run typecheck
npm run test:examples
npm run build
node dist/cli.js --version
```

根目录的 `scripts/install-disco.*` 安装的是上游已发布的 `@arex-skill/disco`，
不会安装本地 `ocsid` 构建；要链接本地构建，运行 `scripts/build-from-source-link.sh`。

## 来源边界

当前集合由保留的 AREX 技能和从 4 个外部源目录导入的 49 个根技能组成。
中央索引内 109 条记录的 `source_commit` 目前全部为 null；49 个导入技能使用
逻辑 repository ID，以满足每个路由技能 ID 唯一的约束。各技能的
`repo-provenance.md` 记录了本地导入来源，但当前索引不是 commit-pinned
复现清单。

## 文档入口

从 [文档索引](docs/README.md) 开始；准确的当前覆盖范围见
[Repository Catalog](docs/repository-catalog.md)。仓库仍保留部分上游（DisCo / AREX-Skill）
开发文档，其中有关原版 1,000 个 repository 的说明不代表本领域子集。

## 许可证

仓库保留上游 [LICENSE](LICENSE)。导入技能可能受各自上游许可证约束，应同时
查看对应技能的 provenance 和 license 字段。
