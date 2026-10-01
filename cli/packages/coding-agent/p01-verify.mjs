import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runAudit } from "./src/audit/runner.ts";
import { persistAuditRun, readArtifacts, resolveAuditRunDir, ARTIFACT_MAX_BYTES } from "./src/audit/records.ts";
import { tokenGrader } from "./src/audit/grader.ts";
import { defaultRequiredFragment, parseCaseAssertions } from "./src/audit/parse.ts";
import { proxyExecutor } from "./src/audit/types.ts";

const withAssertions = (skillId, caseId, assertions) => ({ skillId, caseId, files: { userRequest: `do ${caseId}`, assertionsText: JSON.stringify({ schema: "disco.usability-case.v1", target_skill_area: "x", target_capability: "y", difficulty: "basic", evidence_basis: [], expected_skill_files: [], assertions }) } });
const cases = [ withAssertions("chemprop","train/case-a",["calls chemprop_train_command_builder.py"]), withAssertions("gget","dev/case-c",["calls gget.search"]) ];
const splitIndex = { "chemprop:train/case-a":"train", "gget:dev/case-c":"dev" };

const tmp = mkdtempSync(path.join(tmpdir(),"p01-verify-"));
try {
  const executor = proxyExecutor(() => "artifact-body-for-checksum\n");
  const grader = tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
  const run = await runAudit(cases, { runId: "art-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
  const persisted = persistAuditRun(run, { qualityDir: tmp, kind: "baseline-plumbing" });
  console.log("artifactsPath =", persisted.artifactsPath);

  const rows = readFileSync(persisted.artifactsPath,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  console.log("row count =", rows.length); // expect 2
  const ledger = readFileSync(persisted.ledgerPath,"utf8").trim().split("\n").map(JSON.parse);
  for (const row of rows) {
    const digest = createHash("sha256").update(row.artifact,"utf8").digest("hex");
    const ledgerRow = ledger.find(l => l.skillId===row.skillId && l.caseId===row.caseId);
    if (row.artifactSha256 !== digest) throw new Error("MISMATCH rowSha vs body sha");
    if (ledgerRow?.artifactSha256 !== digest) throw new Error("MISMATCH ledger sha vs body sha");
    if (row.bytes !== Buffer.byteLength(row.artifact,"utf8")) throw new Error("byte mismatch");
  }
  console.log("ACCEPT-1 PASS: artifacts.jsonl sha256 === ledger artifactSha256");

  // oversize truncation
  const big = "x".repeat(ARTIFACT_MAX_BYTES+5000)+"TAIL";
  const ex2 = proxyExecutor(() => big);
  const run2 = await runAudit(cases,{runId:"oversize-1",runAt:"2026-01-01T00:00:00Z"},{executor:ex2,grader,splitIndex});
  const p2 = persistAuditRun(run2,{qualityDir:tmp,kind:"baseline-plumbing"});
  const rows2 = readFileSync(p2.artifactsPath,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const row of rows2) {
    if (row.truncated !== true) throw new Error("expected truncated=true");
    if (row.artifact.length !== ARTIFACT_MAX_BYTES) throw new Error("not truncated to cap");
    if (row.bytes !== ARTIFACT_MAX_BYTES) throw new Error("bytes not truncated actual");
    if (row.artifactSha256 !== createHash("sha256").update(row.artifact,"utf8").digest("hex")) throw new Error("truncated sha mismatch");
  }
  console.log("ACCEPT-3 PASS: oversize truncation flagged");

  // legacy dir backward-compat
  const legacyDir = resolveAuditRunDir(tmp, "legacy-run");
  mkdirSync(legacyDir,{recursive:true});
  writeFileSync(path.join(legacyDir,"ledger.jsonl"),"{}");
  const legacyRead = readArtifacts(legacyDir);
  if (!Array.isArray(legacyRead) || legacyRead.length !== 0) throw new Error("legacy read should be []");
  console.log("ACCEPT-2 PASS: legacy dir without artifacts.jsonl → []");
  console.log("ALL P0-1 VERIFICATION PASSED");
} finally {
  rmSync(tmp,{recursive:true,force:true});
}
