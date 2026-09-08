# 本地配置与校验

当前文件夹包含 live 技能集合和可选的本地 CLI 构建，两者分开校验。

## 环境要求

- Python 3.10 或更高版本：运行领域导入和 router 工具
- Node.js 22.19.0 或更高版本：构建 CLI
- npm：安装 CLI 依赖

## 校验 live 技能集合

在仓库根目录运行：

```powershell
python scripts/rebuild_router.py
python -m unittest scripts.tests.test_domain_scripts -v
```

`rebuild_router.py` 默认只读。

## 构建本地 CLI

```powershell
cd cli
npm install
npm run typecheck
npm run test:examples
npm run build
node dist/cli.js --version
```

本地包为 `ocsid@0.2.1`；作为包 link 或安装后，其命令名为 `ocsid`。

根目录 `scripts/install-disco.ps1` 和 `scripts/install-disco.sh` 是保留的上游
安装器，只安装 `@arex-skill/disco`，不会安装本地 `ocsid`。

## 使用技能集合

完整集合位于 `skills/repositories/`。npm 包只携带相同 taxonomy 的空 router
模板，不包含 109 个 repository skill。

应按目标 agent 支持的方式加载或复制该目录。不要假设
`ocsid repo-skills install` 会安装当前 working-tree 子集；该命令的默认 managed
source 仍是上游 AREX-Skill 仓库。

手工部署时，应把完整 `skills/repositories/` 作为一个整体复制到目标 agent 配置的
skill root，保持 `repo-skills/` 与 `repo-skills-router/` 为同级目录。目标位置已有集合
时先备份，或使用空目录。

## 可选第三方导入

完整计划预期外部源目录包含 `scripts/import_thirdparty.py` 中列出的四个源项目。
脚本允许部分源目录；缺失 cluster 会被报告并跳过。

```powershell
python scripts/import_thirdparty.py --source-root <源目录> --dry-run
python scripts/import_thirdparty.py --source-root <源目录>
python scripts/rebuild_router.py --write-live
```

正式导入前先运行 dry run。已有目标技能会被跳过。

## 本地运行文件

根目录的 `auth.json`、`settings.json`、`sessions/`、`npm/` 与
`cli/node_modules/` 属于本机运行或依赖数据，不是项目文档或技能能力的一部分。
