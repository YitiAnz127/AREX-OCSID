/** Analyze native OCSID session files and the official SkillsBench verifier rewards. No model calls. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = path.resolve(".");
const root = path.resolve(process.argv[2] ?? "examples/researcher/artifacts/ocsid-skillsbench-20261002");
const protocol = JSON.parse(fs.readFileSync(path.join(root, "protocol.json"), "utf8"));
const tasks = ["protein-expression-analysis", "crystallographic-wyckoff-position-analysis", "lab-unit-harmonization"];
const conditions = ["ocsid-full", "ocsid-no-skills"];
const readRows = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const filesBelow = (dir, suffix) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? filesBelow(path.join(dir, entry.name), suffix) : entry.name.endsWith(suffix) ? [path.join(dir, entry.name)] : []);
};
const records = [], issues = [];
for (const task of tasks) {
  const oracleFile = path.join(root, task, "oracle/result.json");
  if (!fs.existsSync(oracleFile) || JSON.parse(fs.readFileSync(oracleFile, "utf8")).reward !== 1) {
    issues.push(`${task}: official oracle has not passed`);
  }
  for (const condition of conditions) {
    const dir = path.join(root, task, condition);
    const resultFile = path.join(dir, "result.json");
    if (!fs.existsSync(resultFile)) continue;
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    const capturedEvents = readRows(path.join(dir, "agent/events.jsonl"));
    const events = result.observationFile ? readRows(path.join(dir, result.observationFile)) : capturedEvents;
    const snapshots = filesBelow(path.join(dir, "agent/runtime"), ".json").map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    const sessions = filesBelow(path.join(dir, "agent/sessions"), ".jsonl");
    const mainSession = sessions.length === 1 ? readRows(sessions[0]) : [];
    const messages = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message);
    const toolStarts = events.filter((event) => event.type === "tool_execution_start");
    const modeValid = snapshots.length > 0 && snapshots.every((snapshot) => snapshot.header?.ocsidMode === "researcher");
    const modelValid = messages.length > 0 && messages.every((message) => message.model === protocol.model && message.provider === "disco-gateway");
    const toolNames = [...new Set(toolStarts.map((event) => event.toolName))];
    const skillReads = toolStarts.filter((event) => event.toolName === "read" &&
      /SKILL\.md|benchmark-skills|repo-skills-router/.test(event.args?.path ?? "")).map((event) => event.args.path);
    const skillBash = toolStarts.filter((event) => event.toolName === "bash" &&
      /SKILL\.md|benchmark-skills|repo-skills-router/.test(event.args?.command ?? "")).map((event) => event.args.command);
    const userMessages = mainSession.filter((entry) => entry.type === "message" && entry.message?.role === "user");
    const promptText = userMessages[0]?.message?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
    const taskBodyUnchanged = promptText === protocol.tasks[task].prompt;
    const finalStopReason = messages.at(-1)?.stopReason ?? null;
    const apiErrors = messages.filter((message) => ["error", "aborted"].includes(message.stopReason))
      .map((message) => message.errorMessage ?? message.stopReason);
    const nativeEvidence = { researcherMode: modeValid, modelOnlyDeepSeek: modelValid, nativeSessionCount: sessions.length,
      mainUserMessages: userMessages.length, originalTaskPromptUnchanged: taskBodyUnchanged,
      registeredSkills: snapshots[0]?.skills.length ?? null,
      registeredTools: snapshots[0]?.activeTools ?? [], observedToolNames: toolNames,
      skillReadPaths: [...new Set(skillReads)], skillRelatedBashCount: skillBash.length,
      workflowInvocations: toolStarts.filter((event) => event.toolName === "workflow").length,
      compactions: events.filter((event) => event.type === "compaction_start").length,
      finalStopReason, transportOrModelErrors: apiErrors };
    if (!modeValid || !modelValid || !taskBodyUnchanged || userMessages.length !== 1) issues.push(`${task}/${condition}: native session identity/prompt audit failed`);
    if (messages.length !== result.modelCalls || toolStarts.length !== result.toolCalls) issues.push(`${task}/${condition}: event accounting mismatch`);
    const reward = Number(fs.readFileSync(path.join(dir, "verifier/reward.txt"), "utf8").trim());
    if (reward !== result.reward) issues.push(`${task}/${condition}: verifier reward mismatch`);
    const completed = finalStopReason === "stop" && (result.exitCode === 0 ||
      result.completionEvidence === "native-final-stop-before-deadline");
    const transcript = path.join(dir, "conversation.html");
    if (sessions.length === 1 && !fs.existsSync(transcript)) {
      const exported = spawnSync(process.execPath, [path.join(repo, "cli/dist/cli.js"), "--export", sessions[0], transcript], { encoding: "utf8", windowsHide: true });
      if (exported.status !== 0) issues.push(`${task}/${condition}: native HTML export failed`);
    }
    records.push({ task, condition, reward, fullyPassed: reward >= 1 - 1e-9, agentCompleted: completed,
      reachedTaskDeadline: result.exitCode === 124, assistantMessages: messages.length,
      completedAssistantResponses: messages.filter((message) => !["error", "aborted"].includes(message.stopReason)).length,
      toolCalls: toolStarts.length, wallMs: result.wallMs, wallMsSource: result.wallMsSource ?? "captured process elapsed time",
      processExitCode: result.exitCode, recovery: result.recovery ?? null,
      capturedAssistantMessages: capturedEvents.filter((event) => event.type === "message_end" && event.message?.role === "assistant").length,
      capturedToolStarts: capturedEvents.filter((event) => event.type === "tool_execution_start").length,
      recordedUsage: result.usage, nativeEvidence,
      transcript: path.relative(root, transcript).replaceAll("\\", "/"), outputExists: result.outputExists });
  }
}
const complete = records.length === tasks.length * conditions.length;
const summaries = Object.fromEntries(conditions.map((condition) => {
  const selected = records.filter((record) => record.condition === condition);
  return [condition, { trials: selected.length, expectedTrials: tasks.length,
    meanReward: selected.length ? selected.reduce((sum, record) => sum + record.reward, 0) / selected.length : null,
    fullyPassedTasks: selected.filter((record) => record.fullyPassed).length,
    agentCompletedTasks: selected.filter((record) => record.agentCompleted).length,
    deadlineTasks: selected.filter((record) => record.reachedTaskDeadline).length,
    assistantMessages: selected.reduce((sum, record) => sum + record.assistantMessages, 0),
    toolCalls: selected.reduce((sum, record) => sum + record.toolCalls, 0),
    recordedTokens: selected.reduce((sum, record) => sum + record.recordedUsage.totalTokens, 0),
    wallMs: selected.reduce((sum, record) => sum + record.wallMs, 0) }];
}));
const deltas = tasks.map((task) => {
  const full = records.find((record) => record.task === task && record.condition === "ocsid-full");
  const noSkills = records.find((record) => record.task === task && record.condition === "ocsid-no-skills");
  return { task, delta: full && noSkills ? full.reward - noSkills.reward : null };
});
const summary = { schema: "ocsid.skillsbench-native-analysis.v1", status: complete ? "complete" : "incomplete",
  protocol, records, summaries, pairedDeltas: deltas,
  meanPairedDelta: complete ? deltas.reduce((sum, item) => sum + item.delta, 0) / tasks.length : null,
  auditIssues: issues,
  note: "One native OCSID trial per condition on three selected scientific tasks. Official verifier rewards assess artifacts; normal agent completion is separate. No population-level significance or full SkillsBench ranking is inferred. Usage is the sum of recorded native assistant usage, not a pricing claim." };
fs.writeFileSync(path.join(root, "analysis.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ status: summary.status, records: records.length, issues, summaries, deltas }, null, 2));
