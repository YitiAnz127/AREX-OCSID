# 选择性技能改进 Pilot：当前可运行部分

本页对应桌面《OCSID_RSI_推荐研究方向与实现路线》的第 1–2 阶段。当前代码提供真实模型的单案例技能快照执行、独立文件判定和固定诊断策略 `U₀`；尚未完成配对探针自动执行、同预算对照、跨技能元任务评估，也没有实验效果结论。

正式实验集是 [`skills/tests/benchmark-v2`](../skills/tests/benchmark-v2/README.md)（`pilot-v2`，与 v1 相同的 4/3/3 技能划分，案例修订版为当前磁盘内容，`contentHash` = `f680ac8b…`），由 `ocsid repo-skills benchmark verify|diff|freeze` 维护，冻结过程与退役的 `benchmark-v1` 都记录在 `benchmark-v2/refreeze-log.jsonl` 中。`benchmark-v1/manifest.json` 的内容摘要与现案树确定不一致（案例在冻结后被改动、`skills/tests/` 未纳入 git 无法复原），该目录原样保留作为身份证据，不再作为测量入口；[当前案例 smoke 快照](../skills/tests/benchmark-smoke-20261001/README.md) 仅覆盖基础设施 smoke，同样不替代正式实验集。

## 单案例执行与私有判定

`--executor agent` 必须配置真实 OpenAI-compatible gateway。缺少地址、模型或密钥会失败，不生成 fake 研究分数。`--verifier` 文件放在技能树外，模型只看到用户任务与技能快照。当前 agent 工具仅开放 `read_file`、`write_file`，写入范围为工作区 `output/`；需要执行 RDKit/Chemprop 命令的案例还需要可信的隔离执行环境。

```powershell
$env:DISCO_GATEWAY_KEY = [Environment]::GetEnvironmentVariable('DISCO_GATEWAY_KEY', 'User')
$env:DISCO_GATEWAY_URL = [Environment]::GetEnvironmentVariable('DISCO_GATEWAY_URL', 'User')
$env:DISCO_GATEWAY_MODEL = [Environment]::GetEnvironmentVariable('DISCO_GATEWAY_MODEL', 'User')
node cli/dist/cli.js repo-skills audit --benchmark skills/tests/benchmark-v2 --run pilot-parent-1 --executor agent --skill <skill-id> --case <case-id> --skill-root skills/repositories/repo-skills --verifier <private-verifier.json> --json
```

桌面 `arex-gateway-runner.mjs` 使用 `DISCO_GATEWAY_KEY`、`DISCO_GATEWAY_URL`、`DISCO_GATEWAY_MODEL` 和 `DISCO_GATEWAY_MAX_TOKENS`；CLI 也接受这些变量。当前用户环境已按该脚本的地址、模型和上限配置；现有 Codex 进程可能需要如上从用户环境载入变量。`DISCO_GATEWAY_KEY` 不写入运行产物；HTTP 会明文传输密钥，CLI 会提示。不要直接运行桌面脚本评估本仓库：它的 `REPO` 指向另一份 `AREX-ocsid` 目录。

父代—候选配对运行在相同参数后加 `--candidate-manifest <candidate.json> --candidate-root <staged-skill-dir> --paired`。CLI 使用同一固定执行配置和私有 verifier；候选 manifest 必须指向当前父技能摘要。两次运行分别以 `<run-id>-parent`、`<run-id>-candidate` 留档，并返回两个分数及差值；缺失分数不会被填成 0。每次运行在质量目录中保存 ledger、artifact、trace、summary 和 `diagnostic-evidence.json`。不提供 `--verifier` 时仍可检查单次执行链路，但文本代理分数不会进入诊断证据的 `score` 字段。

私有判定文件格式：

```json
{
  "schema": "ocsid.workspace-verifier.v1",
  "checks": [
    { "type": "file-exists", "path": "output/result.json" },
    { "type": "json-number-range", "path": "output/result.json", "key": "count", "min": 2, "max": 4 }
  ]
}
```

检查的是工作区真实文件，缺失、格式错误或数值越界均记 0。判定文件摘要写入运行摘要，判定规则本身不会交给模型。

## 原生会话执行（P1-03）

`--executor agent` 是**受控的网关直调入口**，用于单技能局部实验。要经过原生 OCSID 会话（技能发现、router、动态工作流）执行真实任务，用 `--executor native`；它会以子进程方式启动 CLI 自身的 `--researcher` 会话，并把会话身份（session id / mode / provider / model）写进运行摘要与 ledger。

```powershell
# 冻结案例：train/dev 范围内的单案例执行
node cli/dist/cli.js repo-skills audit --benchmark skills/tests/benchmark-v2 --run native-1 --executor native --skill <skill-id> --case <case-id> --agent-provider openai-codex --agent-model gpt-5.5 --wall-ms 600000 --token-budget 400000

# ad-hoc 案例（自带 user request，可另给真实案例的 assertions 参与评分）
node cli/dist/cli.js repo-skills audit --benchmark skills/tests/benchmark-v2 --run native-adhoc-1 --executor native --skill <skill-id> --request <user_request.txt> --assertions <assertions.json> --agent-provider openai-codex --agent-model gpt-5.5

# 真实 held-out 入口（post-freeze 验收，不参与改进信号）
node cli/dist/cli.js repo-skills audit --benchmark skills/tests/benchmark-v2 --run heldout-1 --executor native --skill <skill-id> --case <case-id> --acceptance heldout --agent-provider openai-codex --agent-model gpt-5.5

# 原生 Creator→Researcher：先蒸馏产出技能包，再用该技能跑真实案例
node cli/dist/cli.js repo-skills creator-researcher --source <source-repo> --out <out-dir> --skill <skill-id> --request <user_request.txt> --assertions <assertions.json> --verifier <private-verifier.json> --run native-cr-1 --provider openai-codex --model gpt-5.5 --wall-ms 600000 --token-budget 400000
```

约定与标签：

- 原生运行以 `runKind: native-agent-eval` / `native-candidate-agent-eval` / `native-heldout-acceptance` 记账，`executor` 记为 `agent-native`，**与网关直调分数分开、不混算**；`--acceptance heldout` 只能用于原生运行，运行摘要中会标注 `POST-FREEZE HELD-OUT ACCEPTANCE`。
- 审计工具名映射到原生工具：`read_file`→`read`、`write_file`→`write`、`execute_command`→`bash`（后者要求案例声明 `networkPolicy: "all"`）。
- `--wall-ms` / `--token-budget` 覆盖共享默认预算（真实会话通常需要比 proxy 路径更大的预算）；原生会话的原始 JSONL 流与 stderr 归档为运行目录下的 `native-*-session.jsonl` / `native-*-session.stderr.txt`。
- 不给 `--assertions` 也不给 `--verifier` 时，运行**不写质量 ledger 行**（CLI 会打印 NOTICE）：这只是原生链路的 L2 烟雾，不是任务质量结论。
- 没有可用模型时，可以用仓库自带的确定性替身验证整条链路：`cd cli && npm run test:native-smoke`（本地 Responses API test double + 隔离 agent 目录，12 项断言；它是链路证据，不是模型质量测量）。

## 固定诊断策略 `U₀`

```powershell
ocsid repo-skills diagnose --evidence <run-dir>/diagnostic-evidence.json --probe-budget --json
```

`--probe-budget` 表示实验预先分配了诊断探针预算；策略在单次失败时只建议探针。证据文件可加入受控配对探针的 `probe` 字段（`kind`、`controlled`、`evidenceRef`、`before`、`after`），其中分数必须来自独立 verifier。`U₀` 仅在至少两次受控的 `reference-addition` 配对均改善且平均增益达到 0.25 时建议局部 patch；路由重放与同环境重试的收益不会触发技能修改。输出记录策略版本和摘要，建议本身不修改技能。

这套门槛是可复现的初版规则，不是经实验校准的最优阈值。正式研究还需锁定 `Q` 的同技能新任务、`M` 的未见技能修复任务、总预算、停止规则，以及候选接受和回归标准。

## RSI episode 与人工批准晋升（P1-04 / P1-05）

`diagnose` 只是策略函数，它读的证据（尤其是探针数据）原先要人工准备，候选 patch 也要人工喂进去。现在整条环由一次 `episode run` 驱动，并落盘成一个**持久 episode**（`<quality-dir>/episodes/<episode-id>/episode.json`）：

```powershell
# 1. 一次跑完 探针 → 诊断 → patch 候选 → 回归 → 接受门，停在 awaiting-approval
node cli/dist/cli.js repo-skills episode run --episode ep-1 --skill <skill-id> --case <case-id> \
  --skill-root <skills-root> --evidence <run-dir>/diagnostic-evidence.json \
  --request <user_request.txt> --reference <reference.md> --patch <patch.json> \
  --probe-pairs 2 --executor agent --agent-provider openai-codex --agent-model gpt-5.5

# 2. 查看状态与账本
node cli/dist/cli.js repo-skills episode status --episode ep-1 --json

# 3. 人工批准后晋升（新会话复验），或拒绝（不改 live）
node cli/dist/cli.js repo-skills promote --episode ep-1 --approval "reviewer@2026-10-03 approval-42" \
  --verify-request <user_request.txt> --assertions <assertions.json>
node cli/dist/cli.js repo-skills rollback --episode ep-1 --reason "regression found in production traffic"
```

约定：

- **探针是真实执行的**：`--probe-pairs N`（默认 2 = `U₀` 的 `minimumPairedProbes`）为每条腿各起一个独立 run（独立 runId、独立 driver、同一 config 与 verifier），before 腿用原始 request、after 腿在 request 后追加 `## Reference material (added probe)` 段；报告落在 `<episode-dir>/probe-report.json`。只有全部腿成功、分数非 null 且 config/verifier 组合唯一时才标记 `controlled: true`。
- **策略不被绕过**：诊断只走 `U₀`；`decision` 不是 `patch`（含证据缺失、分数为 null、探针不可控、预算不足）就 abstain，并保留 `U₀` 给出的 diagnosis/decision 作为理由。
- **绝不自动改 live**：episode 只生成候选快照，live 技能库在整个 episode 期间逐字节不变（有测试断言），替换只发生在 `promote`。
- **预算是累计账本**：`probePairs` / `candidates` / `wallMs` / `tokens` 都是「累计用量 + 上限」，检查发生在花钱之前；到达上限记 `budget` 停止（探针/回归已得到的数据会保留）。
- **晋升是人工门**：`promote` 要求非空 `--approval`（「谁在何处批准」）、要求 episode 停在 `awaiting-approval`、要求接受门为 `accepted`；替换在 live 锁内比对候选清单的 `parentSkillDigest` 与当前技能摘要，不符即拒（按当前技能重做候选）。三类事实分开写进 `<quality-dir>/promotions.jsonl`：`approval`（批准）、`file-commit`（文件落地，含备份路径与前后摘要）、`post-verification`（新会话复验结果）。
- **失败会自我撤销**：落地后的树与清单承诺的 `resultSkillDigest` 不一致，或复验未通过，都会走同一事务路径还原备份并把 episode 记为 `failed`；事务中途崩溃由技能库既有的备份/回滚机制还原，账本里不会留下没完成的 `file-commit`。`--no-verify` 只记录提交、**不等于**验证通过。
- patch 目前仍由操作者提供（`--patch`）：编排层不编造 patch 文本，保证证据可复核。

