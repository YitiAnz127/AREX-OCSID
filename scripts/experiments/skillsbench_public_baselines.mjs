/** Read public existing trial results only. Does not call any language model. */
import fs from "node:fs";
import path from "node:path";
const out = path.resolve("examples/researcher/artifacts/ocsid-skillsbench-20261002");
const repository = "benchflow/skillsbench-leaderboard";
const revision = "f104580363a9642563593c475620196ecd36687d";
const tasks = ["protein-expression-analysis", "crystallographic-wyckoff-position-analysis", "lab-unit-harmonization"];
const groups = [
  { model: "GPT-5.5", harness: "OpenHands", paths: ["openhands-no-skills__openai-gpt-5.5", "openhands-no-skills__azure-foundry-openai-gpt-5.5"] },
  { model: "GPT-5.5", harness: "Codex", paths: ["codex-no-skills__openai-gpt-5.5"] },
  { model: "Claude Opus 4.7", harness: "Claude Code", paths: ["claude-code-no-skills__anthropic-claude-opus-4-7", "claude-code-no-skills__aws-bedrock-anthropic-claude-opus-4-7"] },
  { model: "DeepSeek V4 Flash", harness: "OpenHands", paths: ["openhands-no-skills__deepseek-v4-flash"] },
];
async function get(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) { if (attempt === 1) throw error; }
  }
}
const tree = (directory) => get(`https://huggingface.co/api/datasets/${repository}/tree/${revision}/${directory}`);
const records = [], unavailable = [];
for (const group of groups) {
  if (process.argv[2] && group.harness !== process.argv[2]) continue;
  const candidates = new Map(tasks.map((task) => [task, []]));
  for (const leaf of group.paths) {
    const directory = `submissions/skillsbench/v1.1/${leaf}`;
    try {
      const dates = (await tree(directory)).filter((entry) => entry.type === "directory");
      for (const date of dates) {
        const trials = (await tree(date.path)).filter((entry) => entry.type === "directory" &&
          tasks.some((task) => entry.path.split("/").pop().startsWith(`${task}__`)));
        for (const trial of trials) {
          const task = tasks.find((task) => trial.path.split("/").pop().startsWith(`${task}__`));
          const url = `https://huggingface.co/datasets/${repository}/resolve/${revision}/${trial.path}/result.json`;
          const raw = await get(url);
          const reward = raw.rewards?.reward ?? raw.verifier_result?.rewards?.reward ?? null;
          candidates.get(task).push({ task, model: group.model, harness: group.harness, skillMode: "no-skill",
            sourceGroup: leaf, sourceUrl: url, reward, error: raw.error ?? raw.error_info ?? null,
            verifierError: raw.verifier_error ?? null, partialTrajectory: raw.partial_trajectory ?? null,
            timing: raw.timing ?? null, startedAt: raw.started_at ?? null, actualModelId: raw.model ?? null,
            toolCalls: raw.n_tool_calls ?? null });
        }
      }
    } catch (error) { unavailable.push({ group: leaf, reason: String(error.message) }); }
  }
  for (const [task, values] of candidates) {
    const eligible = values.filter((row) => typeof row.reward === "number" && !row.error && !row.verifierError && row.partialTrajectory !== true);
    eligible.sort((a, b) => group.paths.indexOf(a.sourceGroup) - group.paths.indexOf(b.sourceGroup) || String(a.startedAt).localeCompare(String(b.startedAt)));
    const selected = eligible.slice(0, 3);
    records.push({ task, model: group.model, harness: group.harness, availableTrials: values.length,
      eligibleTrials: eligible.length, selectedTrials: selected.length,
      meanReward: selected.length ? selected.reduce((sum, row) => sum + row.reward, 0) / selected.length : null,
      fullyPassed: selected.filter((row) => row.reward >= 1 - 1e-9).length,
      trials: selected,
      excludedTrials: values.filter((row) => !eligible.includes(row)).map((row) => ({ sourceUrl: row.sourceUrl, error: row.error, verifierError: row.verifierError, partialTrajectory: row.partialTrajectory })) });
  }
}
const outputFile = path.join(out, "published-task-baselines.json");
if (process.argv[2] && fs.existsSync(outputFile)) {
  const previous = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  records.push(...previous.records.filter((row) => row.harness !== process.argv[2]));
  unavailable.push(...previous.unavailable);
}
const result = { schema: "ocsid.skillsbench-public-baselines.v1", repository, revision, records, unavailable,
  note: "Derived from public canonical no-skills submission folders. Up to three healthy trials, with source-group priority explicitly retained. These are descriptive existing trial summaries, not a reexecution or a claim to reproduce the official board's complete selection/audit policy." };
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(records.map(({ trials, ...summary }) => summary), null, 2));
