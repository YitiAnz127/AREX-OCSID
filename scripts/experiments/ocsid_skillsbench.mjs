/** Docker adapter: every model conversation is owned by the real OCSID CLI. No model API client here. */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const stage = arg("--stage", "prepare");
const docker = arg("--docker", "C:/Users/ZzzYitiAn127/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe");
const source = path.resolve(arg("--source", "C:/Users/ZzzYitiAn127/Desktop/Agent_lh/SkillsBench-eval"));
const root = path.resolve(arg("--out", path.join(repo, "examples/researcher/artifacts/ocsid-skillsbench-20261002")));
const model = "DeepSeek-V4-Flash-0731-W8A8";
const benchmarkCommit = "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af";
const runtimeTag = "ocsid-eval-runtime:20261002";
const tasks = {
  "protein-expression-analysis": { output: "/root/protein_expression.xlsx" },
  "crystallographic-wyckoff-position-analysis": { output: "/root/workspace/solution.py" },
  "lab-unit-harmonization": { output: "/root/ckd_lab_data_harmonized.csv" },
};
if (!fs.existsSync(docker)) throw new Error("Docker CLI missing");
if (execFileSync("git", ["-c", `safe.directory=${source.replace(/\\/g, "/")}`, "rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() !== benchmarkCommit) {
  throw new Error("SkillsBench must remain pinned to the v1.1 registry commit");
}
fs.mkdirSync(root, { recursive: true });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const imageFor = (task) => `ocsid-sb-${task}:20261002`;
const agentImageFor = (task) => `ocsid-sb-${task}-agent:20261002`;
const runDocker = (args, { logFile, allowFailure = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(docker, args, { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = logFile ? fs.createWriteStream(logFile) : null;
  let output = "";
  const collect = (chunk) => { output += chunk.toString(); log?.write(chunk); };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  child.on("error", (error) => { log?.end(); reject(error); });
  child.on("close", (code) => {
    log?.end();
    if (code !== 0 && !allowFailure) reject(new Error(`Docker ${args[0]} failed (${code}): ${output.slice(-2000)}`));
    else resolve({ code, output });
  });
});
function taskInput(task) {
  const text = fs.readFileSync(path.join(source, "tasks", task, "task.md"), "utf8").replace(/\r\n/g, "\n");
  const parts = text.split(/^---\s*$/m);
  const meta = parts[1];
  return { prompt: parts.slice(2).join("---").trim(),
    timeoutSec: Number(meta.match(/agent:\n\s+timeout_sec:\s*([\d.]+)/)[1]),
    verifierTimeoutSec: Number(meta.match(/verifier:[\s\S]*?timeout_sec:\s*([\d.]+)/)[1]),
    cpus: Number(meta.match(/\bcpus:\s*(\d+)/)[1]), memoryMb: Number(meta.match(/memory_mb:\s*(\d+)/)[1]) };
}
function normalizeShellFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) normalizeShellFiles(full);
    else if (entry.name.endsWith(".sh")) fs.writeFileSync(full, fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n"));
  }
}
async function prepare() {
  const build = path.join(root, ".build");
  const runtimeContext = path.join(build, "runtime");
  const protocolFile = path.join(root, "protocol.json");
  const frozen = fs.existsSync(protocolFile) ? JSON.parse(fs.readFileSync(protocolFile, "utf8")) : null;
  if (frozen) {
    await runDocker(["tag", frozen.runtimeImage, runtimeTag]);
    console.log("Reusing the frozen OCSID runtime image...");
  } else {
    fs.mkdirSync(runtimeContext, { recursive: true });
    for (const file of ["package.json", "npm-shrinkwrap.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      fs.copyFileSync(path.join(repo, "cli", file), path.join(runtimeContext, file));
    }
    for (const dir of ["dist", "docs", "examples"]) fs.cpSync(path.join(repo, "cli", dir), path.join(runtimeContext, dir), { recursive: true });
    fs.copyFileSync(path.join(repo, "scripts/experiments/ocsid-skillsbench/Dockerfile.runtime"), path.join(runtimeContext, "Dockerfile"));
    console.log("Building Linux OCSID runtime from this checkout's compiled CLI...");
    await runDocker(["build", "-t", runtimeTag, runtimeContext], { logFile: path.join(root, "build-runtime.log") });
  }
  const library = path.join(build, "library/repositories");
  if (!fs.existsSync(library)) fs.cpSync(path.join(repo, "skills/repositories"), library, { recursive: true });
  await runDocker(["tag", runtimeTag, "ocsid-eval-runtime-frozen:20261002"]);
  const manifest = { schema: "ocsid.skillsbench-native.v1", benchmark: "SkillsBench v1.1", benchmarkCommit,
    ocsidVersion: JSON.parse(fs.readFileSync(path.join(repo, "cli/package.json"))).version,
    model, modelOutputLimit: 8192, providerTimeoutMs: 600000,
    runtimeImage: (await runDocker(["image", "inspect", runtimeTag, "--format", "{{.Id}}"])).output.trim(),
    conditions: ["ocsid-full", "ocsid-no-skills"], tasks: {} };
  const selectedTask = arg("--task", "");
  for (const [task, spec] of Object.entries(tasks).filter(([task]) => !selectedTask || task === selectedTask)) {
    console.log(`Building official environment: ${task}`);
    const taskRoot = path.join(source, "tasks", task);
    const context = path.join(build, task);
    fs.mkdirSync(context, { recursive: true });
    const reducedRecommendations = task === "protein-expression-analysis" && process.argv.includes("--minimal-apt");
    const ubuntuMirror = task === "protein-expression-analysis" ? arg("--ubuntu-mirror", "") : "";
    if (ubuntuMirror && !/^https:\/\/[a-z0-9.-]+\/ubuntu\/?$/i.test(ubuntuMirror)) throw new Error("Invalid Ubuntu mirror URL");
    const environmentBuild = ["build", "-t", imageFor(task)];
    if (reducedRecommendations || ubuntuMirror) {
      const original = fs.readFileSync(path.join(taskRoot, "environment/Dockerfile"), "utf8").replace(/\r\n/g, "\n");
      let amended = original.replace("apt-get update", "apt-get -o Acquire::Retries=5 update")
        .replace("apt-get install -y", `apt-get -o Acquire::Retries=5 install -y${reducedRecommendations ? " --no-install-recommends" : ""}`);
      if (ubuntuMirror) amended = amended.replace("FROM ubuntu:24.04\n", `FROM ubuntu:24.04\nCOPY --from=ocsid-sb-lab-unit-harmonization:20261002 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt\nRUN sed -i 's|http://archive.ubuntu.com/ubuntu|${ubuntuMirror}|g; s|http://security.ubuntu.com/ubuntu|${ubuntuMirror}|g' /etc/apt/sources.list.d/ubuntu.sources\n`);
      const file = path.join(context, "Dockerfile.environment-adapter");
      fs.writeFileSync(file, amended);
      environmentBuild.push("-f", file);
    }
    environmentBuild.push(path.join(taskRoot, "environment"));
    await runDocker(environmentBuild, { logFile: path.join(root, `build-${task}${ubuntuMirror ? "-mirror" : reducedRecommendations ? "-adapter" : ""}.log`) });
    for (const file of ["Dockerfile.agent", "runtime-audit.mjs"]) {
      fs.copyFileSync(path.join(repo, "scripts/experiments/ocsid-skillsbench", file), path.join(context, file === "Dockerfile.agent" ? "Dockerfile" : file));
    }
    for (const dir of ["oracle", "verifier"]) {
      fs.cpSync(path.join(taskRoot, dir), path.join(context, dir), { recursive: true });
      normalizeShellFiles(path.join(context, dir));
    }
    await runDocker(["build", "--build-arg", `TASK_IMAGE=${imageFor(task)}`, "-t", agentImageFor(task), context], { logFile: path.join(root, `build-agent-${task}.log`) });
    manifest.tasks[task] = { ...spec, ...taskInput(task),
      environmentAdapter: ubuntuMirror ? `Signed Ubuntu repositories downloaded through ${ubuntuMirror}; TLS certificate bundle added; APT retries=5; original package and recommended dependency policy retained. Task/data/oracle/verifier unchanged.` : reducedRecommendations ? "APT download retries=5; same explicitly named packages, without optional recommended packages. Original task/data/oracle/verifier unchanged." : null,
      taskImage: (await runDocker(["image", "inspect", imageFor(task), "--format", "{{.Id}}"])).output.trim(),
      agentImage: (await runDocker(["image", "inspect", agentImageFor(task), "--format", "{{.Id}}"])).output.trim() };
  }
  const prior = fs.existsSync(protocolFile) ? JSON.parse(fs.readFileSync(protocolFile, "utf8")) : null;
  if (prior && prior.runtimeImage !== manifest.runtimeImage) throw new Error("Runtime image changed during task preparation");
  manifest.tasks = { ...(prior?.tasks ?? {}), ...manifest.tasks };
  json(protocolFile, { ...prior, ...manifest });
  console.log(`Prepared ${Object.keys(manifest.tasks).length} official tasks; protocol saved.`);
}
async function grade(task, outputs, logDir, name) {
  const context = path.join(root, ".build", task);
  fs.mkdirSync(logDir, { recursive: true });
  await runDocker(["run", "-d", "--name", name, "--mount", `type=bind,src=${path.join(context, "verifier")},dst=/verifier,readonly`,
    "--mount", `type=bind,src=${logDir},dst=/logs/verifier`, imageFor(task), "sleep", "infinity"]);
  try {
    if (fs.existsSync(outputs)) {
      await runDocker(["exec", name, "mkdir", "-p", path.posix.dirname(tasks[task].output)]);
      await runDocker(["cp", outputs, `${name}:${tasks[task].output}`]);
    }
    const seconds = taskInput(task).verifierTimeoutSec;
    await runDocker(["exec", name, "timeout", String(seconds), "bash", "/verifier/test.sh"], { logFile: path.join(logDir, "docker-verifier.log"), allowFailure: true });
    const rewardFile = path.join(logDir, "reward.txt");
    return { reward: fs.existsSync(rewardFile) ? Number(fs.readFileSync(rewardFile, "utf8").trim()) : null,
      verifierProducedReward: fs.existsSync(rewardFile) };
  } finally { await runDocker(["rm", "-f", name], { allowFailure: true }); }
}
async function runTask(task, condition) {
  if (!tasks[task]) throw new Error("Unknown task");
  const oracle = condition === "oracle";
  if (!oracle && !["ocsid-full", "ocsid-no-skills"].includes(condition)) throw new Error("Unknown condition");
  const input = taskInput(task);
  const dir = path.join(root, task, condition);
  if (fs.existsSync(path.join(dir, "result.json"))) throw new Error("Run already exists; refusing to rerun a scored task");
  fs.mkdirSync(dir, { recursive: true });
  const logs = path.join(dir, "agent"); fs.mkdirSync(logs, { recursive: true });
  const outputs = path.join(dir, "output", path.posix.basename(tasks[task].output));
  fs.mkdirSync(path.dirname(outputs), { recursive: true });
  const name = `ocsid-sb-${task}-${condition}-${Date.now()}`;
  const context = path.join(root, ".build", task);
  const create = ["run", "-d", "--init", "--name", name, "--cpus", String(input.cpus), "--memory", `${input.memoryMb}m`];
  if (oracle) create.push("--mount", `type=bind,src=${path.join(context, "oracle")},dst=/oracle,readonly`);
  else {
    if (!process.env.DISCO_GATEWAY_KEY || !process.env.DISCO_GATEWAY_URL) throw new Error("Gateway environment is missing");
    const config = path.join(dir, "config"); fs.mkdirSync(config, { recursive: true });
    if (condition === "ocsid-full") fs.mkdirSync(path.join(config, "skills/repositories"), { recursive: true });
    json(path.join(config, "models.json"), { providers: { "disco-gateway": {
      baseUrl: process.env.DISCO_GATEWAY_URL, apiKey: "$DISCO_GATEWAY_KEY", api: "openai-completions",
      models: [{ id: model, name: model, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: "max_tokens" } }] } } });
    json(path.join(config, "settings.json"), { defaultProvider: "disco-gateway", defaultModel: model,
      defaultThinkingLevel: "off", httpIdleTimeoutMs: 600000, retry: { provider: { timeoutMs: 600000, maxRetries: 0 } } });
    const workflowConfig = path.join(dir, "workflow-config"); fs.mkdirSync(workflowConfig, { recursive: true });
    json(path.join(workflowConfig, "model-tiers.json"), { tiers: { small: `disco-gateway/${model}`, medium: `disco-gateway/${model}`, big: `disco-gateway/${model}` } });
    create.push("--mount", `type=bind,src=${config},dst=/opt/eval-config`,
      "--mount", `type=bind,src=${logs},dst=/logs/agent`,
      "--mount", `type=bind,src=${path.join(workflowConfig, "model-tiers.json")},dst=/root/.ocsid/workflows/model-tiers.json,readonly`,
      "--env", "OCSID_CODING_AGENT_DIR=/opt/eval-config");
    if (condition === "ocsid-full") create.push("--mount", `type=bind,src=${path.join(root, ".build/library/repositories")},dst=/opt/eval-config/skills/repositories,readonly`,
      "--mount", `type=bind,src=${path.join(source, "tasks", task, "environment/skills")},dst=/opt/benchmark-skills,readonly`);
  }
  create.push(oracle ? imageFor(task) : agentImageFor(task), "sleep", "infinity");
  await runDocker(create);
  let execution;
  try {
    if (oracle) execution = await runDocker(["exec", name, "timeout", String(input.timeoutSec), "bash", "/oracle/solve.sh"], { logFile: path.join(logs, "oracle.log"), allowFailure: true });
    else {
      const available = await runDocker(["exec", "--env", "DISCO_GATEWAY_KEY", name, "node", "/opt/ocsid/dist/cli.js", "--offline", "--list-models", "disco-gateway"],
        { logFile: path.join(logs, "model-preflight.log") });
      if (!available.output.includes(model)) throw new Error("Native OCSID model registry did not expose the configured model");
      const cli = ["exec", "--env", "DISCO_GATEWAY_KEY", name, "timeout", "--signal=TERM", "--kill-after=15", String(input.timeoutSec),
        "node", "/opt/ocsid/dist/cli.js", "--researcher", "--mode", "json", "--print", "--approve", "--offline",
        "--provider", "disco-gateway", "--model", model, "--session-dir", "/logs/agent/sessions",
        "--extension", "/opt/eval/runtime-audit.mjs"];
      if (condition === "ocsid-full") cli.push("--skill", "/opt/benchmark-skills");
      else cli.push("--no-skills");
      cli.push(input.prompt);
      execution = await runNativeCli(cli, logs);
    }
    await runDocker(["cp", `${name}:${tasks[task].output}`, outputs], { allowFailure: true });
    if (!oracle) await runDocker(["cp", `${name}:/root/.ocsid/workflows`, path.join(dir, "workflows")], { allowFailure: true });
  } finally { await runDocker(["rm", "-f", name], { allowFailure: true }); }
  const verdict = await grade(task, outputs, path.join(dir, "verifier"), `${name}-grader`);
  const result = { task, condition, architecture: oracle ? "official-oracle" : "native OCSID CLI Researcher", model: oracle ? null : model,
    ...execution, ...verdict, outputExists: fs.existsSync(outputs), benchmarkCommit };
  json(path.join(dir, "result.json"), result);
  console.log(JSON.stringify(result));
}
function runNativeCli(args, logs) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const events = fs.createWriteStream(path.join(logs, "events.jsonl"));
    const stderr = fs.createWriteStream(path.join(logs, "stderr.log"));
    const start = Date.now(); let pending = "", modelCalls = 0, toolCalls = 0, usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const keep = new Set(["session", "message_end", "tool_execution_start", "tool_execution_end", "turn_start", "turn_end", "agent_start", "agent_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"]);
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n"); pending = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (keep.has(event.type)) events.write(JSON.stringify(event) + "\n");
        if (event.type === "tool_execution_start") { toolCalls++; console.log(`OCSID tool ${event.toolName}`); }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          modelCalls++;
          const u = event.message.usage ?? {};
          for (const key of Object.keys(usage)) usage[key] += Number(u[key] ?? 0);
          console.log(`OCSID assistant turn ${modelCalls}: ${event.message.stopReason}`);
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => { events.end(); stderr.end(); resolve({ exitCode: code, wallMs: Date.now() - start, modelCalls, toolCalls, usage }); });
  });
}
async function recoverCompletedTask(task, condition, container) {
  if (!tasks[task] || !["ocsid-full", "ocsid-no-skills"].includes(condition)) throw new Error("Unknown recovery target");
  const dir = path.join(root, task, condition), logs = path.join(dir, "agent");
  if (fs.existsSync(path.join(dir, "result.json"))) throw new Error("A scored run cannot be recovered again");
  const state = JSON.parse((await runDocker(["inspect", container])).output)[0];
  const protocol = JSON.parse(fs.readFileSync(path.join(root, "protocol.json"), "utf8"));
  if (state.State.Running || !state.Name.startsWith(`/ocsid-sb-${task}-${condition}-`) ||
      state.Image !== protocol.tasks[task].agentImage) throw new Error("Recovery must use the original stopped task container");
  const mount = state.Mounts.find((item) => item.Destination === "/logs/agent");
  if (!mount || path.resolve(mount.Source).toLowerCase() !== path.resolve(logs).toLowerCase()) throw new Error("Recovery log mount mismatch");
  const sessionDir = path.join(logs, "sessions");
  const sessionFiles = fs.readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
  if (sessionFiles.length !== 1) throw new Error("Recovery needs one unambiguous native session");
  const rows = fs.readFileSync(path.join(sessionDir, sessionFiles[0]), "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const messages = rows.filter((row) => row.type === "message" && row.message?.role === "assistant");
  const user = rows.filter((row) => row.type === "message" && row.message?.role === "user");
  const prompt = user[0]?.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const header = rows.find((row) => row.type === "session");
  const last = messages.at(-1);
  const wallMs = Date.parse(last?.timestamp) - Date.parse(header?.timestamp);
  if (header?.ocsidMode !== "researcher" || user.length !== 1 || prompt !== protocol.tasks[task].prompt ||
      !messages.every((row) => row.message.model === model && row.message.provider === "disco-gateway") ||
      last?.message.stopReason !== "stop" || !(wallMs >= 0 && wallMs < protocol.tasks[task].timeoutSec * 1000)) {
    throw new Error("Native session does not prove final completion before the original deadline");
  }
  // Keep the truncated captured stream untouched. This separate census is derived from native session messages.
  const census = rows.filter((row) => row.type === "message").flatMap((row) => {
    const result = [{ type: "message_end", message: row.message, source: "native-session-recovery", timestamp: row.timestamp }];
    if (row.message.role === "assistant") for (const block of row.message.content ?? []) {
      if (block.type === "toolCall") result.push({ type: "tool_execution_start", toolName: block.name, args: block.arguments,
        toolCallId: block.id, source: "native-session-recovery", timestamp: row.timestamp });
    }
    return result;
  });
  const observationFile = "agent/native-session-census.jsonl";
  fs.writeFileSync(path.join(dir, observationFile), census.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  for (const row of messages) for (const key of Object.keys(usage)) usage[key] += Number(row.message.usage?.[key] ?? 0);
  const outputs = path.join(dir, "output", path.posix.basename(tasks[task].output));
  await runDocker(["cp", `${container}:${tasks[task].output}`, outputs]);
  const verdict = await grade(task, outputs, path.join(dir, "verifier"), `ocsid-sb-recovered-grader-${Date.now()}`);
  const result = { task, condition, architecture: "native OCSID CLI Researcher", model, exitCode: null, wallMs,
    wallMsSource: "native-session header to final assistant entry; process overhead unobserved",
    completionEvidence: "native-final-stop-before-deadline", modelCalls: messages.length,
    toolCalls: census.filter((row) => row.type === "tool_execution_start").length, usage, ...verdict,
    outputExists: fs.existsSync(outputs), benchmarkCommit, observationFile,
    recovery: { reason: "Host event collector stopped; native session and original container artifact survived",
      recoveredAt: new Date().toISOString(), originalContainer: container, containerState: state.State,
      processExitCodeObserved: false, additionalModelCalls: 0, originalEventsPreserved: true } };
  json(path.join(dir, "result.json"), result);
  console.log(JSON.stringify(result));
}
if (stage === "prepare") await prepare();
else if (stage === "run") await runTask(arg("--task", ""), arg("--condition", "ocsid-full"));
else if (stage === "recover") await recoverCompletedTask(arg("--task", ""), arg("--condition", ""), arg("--container", ""));
else throw new Error("--stage must be prepare, run or recover");
