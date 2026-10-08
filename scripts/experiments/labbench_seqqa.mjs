/** Bounded, paired LAB-Bench SeqQA pilot. Gold answers never enter model prompts. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const sourceRoot = path.resolve(arg("--source", ""));
const outputRoot = path.resolve(arg("--out", ""));
const skillRoot = path.resolve(arg("--skill-root", ""));
const limitPerFamily = Number(arg("--limit-per-family", "0"));
const maxCalls = Number(arg("--max-calls", "0"));
const timeoutMs = Number(arg("--timeout-ms", "90000"));
const recoverTimeouts = process.argv.includes("--recover-timeouts");
const prepareOnly = process.argv.includes("--prepare");
const seed = "OCSID-LAB-SeqQA-20261001-v1";
const sourceCommit = "998a8e0a40cf116c80e1b0e7a805ebb5fb9fa838";
const families = ["Prop-seq-gcpercent", "ORF-seq-AAseq", "RE-seq-lenfrags"];
const models = {
  deepseek_no: "DeepSeek-V4-Flash-0731-W8A8",
  deepseek_skill: "DeepSeek-V4-Flash-0731-W8A8",
};
const refuseChoice = "Insufficient information to answer the question";
if (!fs.existsSync(path.join(sourceRoot, "SeqQA"))) throw new Error("LAB-Bench SeqQA source missing");
if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) throw new Error("Biopython skill missing");
if (!Number.isInteger(limitPerFamily) || limitPerFamily < 0 || !Number.isInteger(maxCalls) || maxCalls < 0 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
  throw new Error("limits must be nonnegative integers");
}
const skillFiles = [
  path.join(skillRoot, "SKILL.md"),
  path.join(skillRoot, "sub-skills", "sequence-objects-and-features", "SKILL.md"),
];
const skillText = skillFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n\n");
const skillDigest = sha(skillText);
const selected = [];
const gold = new Map();
for (const family of families) {
  const file = path.join(sourceRoot, "SeqQA", `${family}-v1-public.jsonl`);
  const split = JSON.parse(fs.readFileSync(path.join(sourceRoot, "SeqQA", `${family}-v1-splits.json`), "utf8"));
  const publicIds = new Set(split.public);
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  for (const row of rows) if (!publicIds.has(row.id)) throw new Error(`non-public case in ${family}`);
  rows.sort((a, b) => sha(`${seed}|${a.id}`).localeCompare(sha(`${seed}|${b.id}`)));
  for (const row of rows.slice(0, 10)) {
    const choices = [row.ideal, refuseChoice, ...row.distractors];
    const order = choices.map((_, i) => i).sort((a, b) =>
      sha(`${seed}|${row.id}|choice|${a}`).localeCompare(sha(`${seed}|${row.id}|choice|${b}`)));
    selected.push({ family, id: row.id, choiceOrder: order });
    gold.set(row.id, row);
  }
}
const manifest = {
  schema: "ocsid.labbench-seqqa-pilot.v1", seed, sourceCommit,
  source: "https://github.com/Future-House/LAB-Bench", skillDigest,
  families, selected, models, promptProtocol: "fixed multiple-choice, no tools, temperature 0, max_tokens 512",
};
fs.mkdirSync(outputRoot, { recursive: true });
const manifestPath = path.join(outputRoot, "selection.json");
if (fs.existsSync(manifestPath)) {
  const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error("frozen selection or skill changed");
} else {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
}
if (prepareOnly) {
  console.log(JSON.stringify({ manifestPath, selected: selected.length, families, skillDigest }));
  process.exit(0);
}
if (!limitPerFamily || !maxCalls) throw new Error("--limit-per-family and --max-calls are required for a run");
const key = process.env.DISCO_GATEWAY_KEY;
const baseUrl = process.env.DISCO_GATEWAY_URL;
if (!key || !baseUrl) throw new Error("DISCO_GATEWAY_KEY and DISCO_GATEWAY_URL must be set");
const runItems = families.flatMap((family) => selected.filter((item) => item.family === family).slice(0, limitPerFamily));
const plannedCalls = runItems.length * Object.keys(models).length;
if (plannedCalls > maxCalls) throw new Error(`planned ${plannedCalls} calls exceeds --max-calls ${maxCalls}`);
const resultsPath = path.join(outputRoot, "results.jsonl");
const previousRows = fs.existsSync(resultsPath)
  ? fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const done = new Set(previousRows.map((row) => `${row.id}|${row.arm}`));
const recoveryPath = path.join(outputRoot, "timeout-recovery.jsonl");
const recoverable = new Set(previousRows.filter((row) => row.error && /timeout/i.test(row.error))
  .map((row) => `${row.id}|${row.arm}`));
const recoveryRows = fs.existsSync(recoveryPath) ? fs.readFileSync(recoveryPath, "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const recovered = new Set(recoveryRows.map((row) => `${row.id}|${row.arm}`));
if (recoverTimeouts && plannedCalls + recoverable.size > maxCalls) {
  throw new Error(`base and timeout recovery require ${plannedCalls + recoverable.size} calls`);
}
const letter = (i) => String.fromCharCode(65 + i);
let newCalls = 0;
for (const item of runItems) {
  const row = gold.get(item.id);
  const options = item.choiceOrder.map((index, i) => `(${letter(i)}) ${[row.ideal, refuseChoice, ...row.distractors][index]}`);
  const correctLetter = letter(item.choiceOrder.indexOf(0));
  const refuseLetter = letter(item.choiceOrder.indexOf(1));
  const user = `The following is a multiple-choice biology question. Answer with exactly one letter in [ANSWER] and [/ANSWER] tags.\n\nQuestion: ${row.question}\n\nOptions:\n${options.join("\n")}`;
  const arms = Object.keys(models).sort((a, b) =>
    sha(`${seed}|${item.id}|arm|${a}`).localeCompare(sha(`${seed}|${item.id}|arm|${b}`)));
  for (const arm of arms) {
    const callKey = `${item.id}|${arm}`;
    const recovery = done.has(callKey) && recoverTimeouts && recoverable.has(callKey) && !recovered.has(callKey);
    if (done.has(callKey) && !recovery) continue;
    const system = arm === "deepseek_skill"
      ? `You may use the following Biopython skill guidance for the task. You have no execution tools.\n\n${skillText}`
      : "Answer the biology question using your own knowledge. You have no tools.";
    const body = { model: models[arm], temperature: 0, max_tokens: 512,
      messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    const start = Date.now();
    let output = "", usage = null, error = null, errorKind = null, finishReason = null;
    const startedAt = new Date().toISOString();
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(payload?.error?.message ?? "unknown").replaceAll(key, "<redacted>").slice(0, 200)}`);
      output = typeof payload?.choices?.[0]?.message?.content === "string" ? payload.choices[0].message.content : "";
      usage = payload.usage ?? null;
      finishReason = payload?.choices?.[0]?.finish_reason ?? null;
    } catch (cause) {
      error = String(cause?.message ?? cause).replaceAll(key, "<redacted>").slice(0, 250);
      errorKind = cause?.name === "TimeoutError" || /timeout/i.test(error) ? "timeout" : "request";
    }
    const match = output.match(/\[ANSWER\]\s*([A-Z])\s*\[\/ANSWER\]/i);
    const answer = match?.[1]?.toUpperCase() ?? null;
    const result = {
      id: item.id, family: item.family, arm, model: models[arm], answer,
      correct: answer === correctLetter, sure: answer !== null && answer !== refuseLetter,
      validFormat: answer !== null, error, errorKind, usage, wallMs: Date.now() - start,
      startedAt, timeoutMs, finishReason, recovery,
      promptSha256: sha(JSON.stringify(body.messages)), rawOutput: output.slice(0, 2000),
    };
    fs.appendFileSync(recovery ? recoveryPath : resultsPath, JSON.stringify(result) + "\n");
    newCalls += 1;
    console.log(`${item.family} ${item.id.slice(0, 8)} ${arm} ${result.correct ? "PASS" : error ? "ERROR" : "FAIL"} ${result.wallMs}ms`);
    if (error && errorKind !== "timeout") throw new Error(`stopped after ${arm}: ${error}`);
  }
}
console.log(JSON.stringify({ resultPath: resultsPath, plannedCalls, newCalls, completed: done.size + newCalls }));
