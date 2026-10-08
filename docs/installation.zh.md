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
安装器，只安装上游已发布的 `@arex-skill/disco`，不会安装本地 `ocsid` 构建。

## 使用技能集合

完整集合位于 `skills/repositories/`。npm 包只携带相同 taxonomy 的空 router
模板，不包含 109 个 repository skill。

应按目标 agent 支持的方式加载或复制该目录。不要假设
`ocsid repo-skills install` 会安装当前 working-tree 子集；该命令的默认 managed
source 是 `https://github.com/YitiAnz127/ocsid-repo-skill.git`。

手工部署时，应把完整 `skills/repositories/` 作为一个整体复制到目标 agent 配置的
skill root，保持 `repo-skills/` 与 `repo-skills-router/` 为同级目录。目标位置已有集合
时先备份，或使用空目录。

## 写明实际部署的集合（部署验收）

由于 npm 包只带空 router，而 `ocsid repo-skills install` 拉取的是远端集合，「技能已安装」
本身是有歧义的。完整的部署记录必须写明当前生效的是哪个集合，并记录其身份：

```powershell
node dist/cli.js repo-skills status          # managed 与 local 集合的身份
python scripts/rebuild_router.py             # working-tree 索引一致性
```

`status` 输出的每个字段都要记录：Source、Commit、Official skills（由 `ocsid` 管理）、
Local skills、Total repo skills、Routed repositories、Area-family assignments、
Router taxonomy、Files、Router、Drift。出现 `Official skills: 0` 加 `Local skills: 109`
表示部署使用的是 working-tree 集合，并没有安装 npm 托管集合；反之，如果部署确实依赖
`repo-skills install`，必须记录实际落地的 source repository 与 40 位 commit，而不只是技能数。
本仓库当前实测输出：

```text
Installed: yes
Managed by ocsid: no
Official skills: 0
Local skills: 109
Total repo skills: 109
Routed repositories: 109
Area-family assignments: 127
Router taxonomy: 2 areas, 10 families
Files: 2503
Router: enabled
Drift: none
```

commit 钉住是部分的：109 条记录中 38 条带已记录的 `source_commit`，71 条没有（见
`docs/imported-repo-skills.md`）。因此 working-tree 集合是身份与路由清单，而不是完全
commit 钉住的清单；这一限制也要写进部署记录。

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

本机运行状态（登录凭据、设置、会话、已安装技能）存放在 OCSID agent 目录，默认
`~/.ocsid/agent`，不在本仓库内，也不属于项目文档或技能能力的一部分。
`cli/node_modules/` 属于依赖数据。
