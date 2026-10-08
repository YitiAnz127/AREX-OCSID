/** Paired task-level summary for the frozen LAB-Bench SeqQA pilot. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const outputRoot = path.resolve(process.argv[2] ?? "");
const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "selection.json"), "utf8"));
const rows = fs.readFileSync(path.join(outputRoot, "results.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const expectedArms = ["deepseek_no", "deepseek_skill"];
const rowMap = new Map();
for (const row of rows) {
  const key = `${row.id}|${row.arm}`;
  if (rowMap.has(key)) throw new Error(`duplicate result ${key}`);
  rowMap.set(key, row);
}
const expected = manifest.selected.flatMap((item) => expectedArms.map((arm) => `${item.id}|${arm}`));
for (const key of rowMap.keys()) if (!expected.includes(key)) throw new Error(`unexpected result ${key}`);
const complete = expected.every((key) => rowMap.has(key));

function wilson(successes, n) {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = successes / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [center - half, center + half];
}
const byArm = {};
for (const arm of expectedArms) {
  const armRows = manifest.selected.map((item) => rowMap.get(`${item.id}|${arm}`)).filter(Boolean);
  const correct = armRows.filter((row) => row.correct).length;
  const attempted = armRows.filter((row) => row.sure).length;
  const usage = armRows.reduce((acc, row) => {
    acc.inputTokens += row.usage?.prompt_tokens ?? 0;
    acc.outputTokens += row.usage?.completion_tokens ?? 0;
    acc.totalTokens += row.usage?.total_tokens ?? 0;
    acc.wallMs += row.wallMs ?? 0;
    return acc;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, wallMs: 0 });
  byArm[arm] = {
    rows: armRows.length, denominator: manifest.selected.length, correct,
    accuracy: complete ? correct / manifest.selected.length : null,
    wilson95: complete ? wilson(correct, manifest.selected.length) : null,
    coverage: complete ? attempted / manifest.selected.length : null,
    precision: attempted ? correct / attempted : null,
    formatFailures: armRows.filter((row) => !row.validFormat && !row.error).length,
    errors: armRows.filter((row) => row.error).length,
    usage,
  };
}
const byFamily = {};
for (const family of manifest.families) {
  const items = manifest.selected.filter((item) => item.family === family);
  byFamily[family] = Object.fromEntries(expectedArms.map((arm) => {
    const values = items.map((item) => rowMap.get(`${item.id}|${arm}`));
    return [arm, { correct: values.filter((row) => row?.correct).length,
      completed: values.filter(Boolean).length, denominator: items.length }];
  }));
}
let wins = 0, losses = 0, ties = 0;
for (const item of manifest.selected) {
  const plain = rowMap.get(`${item.id}|deepseek_no`);
  const skill = rowMap.get(`${item.id}|deepseek_skill`);
  if (!plain || !skill) continue;
  if (skill.correct && !plain.correct) wins += 1;
  else if (!skill.correct && plain.correct) losses += 1;
  else ties += 1;
}

let pairedDelta = null, stratifiedBootstrap95 = null;
if (complete) {
  pairedDelta = byArm.deepseek_skill.accuracy - byArm.deepseek_no.accuracy;
  let state = Number.parseInt(crypto.createHash("sha256").update(manifest.seed).digest("hex").slice(0, 8), 16);
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const groups = manifest.families.map((family) => manifest.selected.filter((item) => item.family === family));
  const draws = [];
  for (let repeat = 0; repeat < 10000; repeat += 1) {
    let sum = 0;
    for (const group of groups) for (let i = 0; i < group.length; i += 1) {
      const item = group[Math.floor(random() * group.length)];
      sum += Number(rowMap.get(`${item.id}|deepseek_skill`).correct) - Number(rowMap.get(`${item.id}|deepseek_no`).correct);
    }
    draws.push(sum / manifest.selected.length);
  }
  draws.sort((a, b) => a - b);
  stratifiedBootstrap95 = [draws[249], draws[9749]];
}
const analysis = {
  schema: "ocsid.labbench-seqqa-analysis.v1",
  status: complete ? "complete" : "incomplete",
  sourceCommit: manifest.sourceCommit,
  skillDigest: manifest.skillDigest,
  expectedCalls: expected.length, recordedCalls: rows.length,
  byArm, byFamily, paired: { wins, losses, ties, delta: pairedDelta, stratifiedBootstrap95 },
  note: "Public LAB-Bench subset; one frozen choice permutation; one run per condition. Timeout/error counts as incorrect in the intention-to-treat denominator. Token totals omit usage for timed-out requests.",
};
const recoveryPath = path.join(outputRoot, "timeout-recovery.jsonl");
const recoveryRows = fs.existsSync(recoveryPath) ? fs.readFileSync(recoveryPath, "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const recoveryMap = new Map();
for (const row of recoveryRows) {
  const key = `${row.id}|${row.arm}`;
  if (recoveryMap.has(key) || !rowMap.get(key)?.error) throw new Error(`invalid timeout recovery ${key}`);
  recoveryMap.set(key, row);
}
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
};
function summarizeView(deadline90) {
  const outcome = (item, arm) => {
    const key = `${item.id}|${arm}`;
    const original = rowMap.get(key);
    if (!original) return null;
    if (deadline90) return Number(!original.error && original.wallMs <= 90000 && original.correct);
    const effective = recoveryMap.get(key) ?? original;
    return effective.error ? null : Number(effective.correct);
  };
  const arms = Object.fromEntries(expectedArms.map((arm) => {
    const values = manifest.selected.map((item) => outcome(item, arm));
    const resolved = values.filter((value) => value !== null);
    const successes = resolved.reduce((sum, value) => sum + value, 0);
    const unknown = values.length - resolved.length;
    return [arm, { correct: successes, denominator: values.length, resolved: resolved.length, unknown,
      accuracy: complete && unknown === 0 ? successes / values.length : null,
      completedAccuracy: resolved.length ? successes / resolved.length : null,
      lowerBound: complete ? successes / values.length : null,
      upperBound: complete ? (successes + unknown) / values.length : null,
      wilson95: complete && unknown === 0 ? wilson(successes, values.length) : null }];
  }));
  const families = Object.fromEntries(manifest.families.map((family) => {
    const items = manifest.selected.filter((item) => item.family === family);
    return [family, Object.fromEntries(expectedArms.map((arm) => {
      const values = items.map((item) => outcome(item, arm));
      return [arm, { correct: values.reduce((sum, value) => sum + (value ?? 0), 0),
        denominator: values.length, unknown: values.filter((value) => value === null).length }];
    }))];
  }));
  const differences = manifest.selected.map((item) => {
    const skill = outcome(item, "deepseek_skill"), plain = outcome(item, "deepseek_no");
    return { family: item.family, value: skill === null || plain === null ? null : skill - plain,
      lower: (skill ?? 0) - (plain ?? 1), upper: (skill ?? 1) - (plain ?? 0) };
  });
  const resolvedPairs = differences.filter((item) => item.value !== null);
  let interval = null;
  if (complete && resolvedPairs.length === differences.length) {
    let state = 173091;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    const draws = [];
    const groups = manifest.families.map((family) => differences.filter((item) => item.family === family));
    for (let i = 0; i < 10000; i += 1) {
      let sum = 0;
      for (const group of groups) for (let j = 0; j < group.length; j += 1) sum += group[Math.floor(random() * group.length)].value;
      draws.push(sum / differences.length);
    }
    interval = [quantile(draws, 0.025), quantile(draws, 0.975)];
  }
  return { byArm: arms, byFamily: families, paired: {
    resolvedPairs: resolvedPairs.length,
    wins: resolvedPairs.filter((item) => item.value > 0).length,
    losses: resolvedPairs.filter((item) => item.value < 0).length,
    ties: resolvedPairs.filter((item) => item.value === 0).length,
    delta: complete && resolvedPairs.length === differences.length ? resolvedPairs.reduce((sum, item) => sum + item.value, 0) / differences.length : null,
    lowerBound: complete ? differences.reduce((sum, item) => sum + item.lower, 0) / differences.length : null,
    upperBound: complete ? differences.reduce((sum, item) => sum + item.upper, 0) / differences.length : null,
    stratifiedBootstrap95: interval,
  } };
}
analysis.deadline90 = summarizeView(true);
analysis.extendedAllowance = summarizeView(false);
for (const arm of expectedArms) {
  const effective = manifest.selected.map((item) => recoveryMap.get(`${item.id}|${arm}`) ?? rowMap.get(`${item.id}|${arm}`)).filter(Boolean);
  Object.assign(analysis.extendedAllowance.byArm[arm], {
    formatFailures: effective.filter((row) => !row.error && !row.validFormat).length,
    refusals: effective.filter((row) => row.validFormat && !row.sure).length,
    wrongValidChoices: effective.filter((row) => row.validFormat && row.sure && !row.correct).length,
    formatFailuresAtOutputCap: effective.filter((row) => !row.error && !row.validFormat && row.usage?.completion_tokens === 512).length,
    errors: effective.filter((row) => row.error).length,
  });
}
analysis.recoveryCalls = recoveryRows.length;
analysis.latency = Object.fromEntries(expectedArms.map((arm) => {
  const values = rows.filter((row) => row.arm === arm && !row.error).map((row) => row.wallMs);
  return [arm, { completed: values.length, medianMs: quantile(values, 0.5), p90Ms: quantile(values, 0.9),
    responsesAfter90s: values.filter((value) => value > 90000).length }];
}));
analysis.recordedUsageLowerBound = [...rows, ...recoveryRows].reduce((acc, row) => {
  acc.inputTokens += row.usage?.prompt_tokens ?? 0;
  acc.outputTokens += row.usage?.completion_tokens ?? 0;
  acc.totalTokens += row.usage?.total_tokens ?? 0;
  acc.wallMs += row.wallMs ?? 0;
  return acc;
}, { inputTokens: 0, outputTokens: 0, totalTokens: 0, wallMs: 0 });
analysis.recordedUsageByArm = Object.fromEntries(expectedArms.map((arm) => [arm,
  [...rows, ...recoveryRows].filter((row) => row.arm === arm).reduce((acc, row) => {
    acc.inputTokens += row.usage?.prompt_tokens ?? 0;
    acc.outputTokens += row.usage?.completion_tokens ?? 0;
    acc.totalTokens += row.usage?.total_tokens ?? 0;
    return acc;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })]));
analysis.originalLogs = { byArm: analysis.byArm, byFamily: analysis.byFamily, paired: analysis.paired,
  meaning: "Recorded-request outcome under each request's original deadline. Because the deadline changed mid-run, use deadline90 or extendedAllowance for interpretable comparisons." };
delete analysis.byArm;
delete analysis.byFamily;
delete analysis.paired;
analysis.note = "The original logs are preserved. deadline90 measures operational correct-answer completion within 90 seconds. extendedAllowance uses the user's 600-second amendment and separately recorded timeout recovery; unresolved answers remain unknown and have bounds. Completed-only accuracy is descriptive and subject to missingness selection. Token totals exclude unreported usage for timed-out requests.";
fs.writeFileSync(path.join(outputRoot, "analysis.json"), JSON.stringify(analysis, null, 2) + "\n");
console.log(JSON.stringify({ status: analysis.status, recordedCalls: rows.length, expectedCalls: expected.length,
  recoveryCalls: recoveryRows.length, extendedAccuracy: analysis.extendedAllowance.byArm, paired: analysis.extendedAllowance.paired }));
