import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runOnboard } from "../commands/onboard.js";
import { defaultPolicy } from "../config.js";
import { buildFingerprint, diffFingerprints } from "../fingerprint/index.js";
import { revertSession } from "../fixers/transaction.js";
import { applyPolicy } from "../policy.js";
import { toSarif } from "../report/sarif.js";
import { scanAll } from "../scanners/index.js";
import { Diagnosis, Receipt } from "../types.js";
import { looksLikePlaceholder } from "../util/placeholder.js";
import { normalizeOutput } from "../verify/repro.js";

const fixtures = fileURLToPath(new URL("../../test-fixtures/", import.meta.url));

async function copyFixture(name: string): Promise<string> {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), `env-doctor-${name}-`));
  await fs.cp(path.join(fixtures, name), target, { recursive: true });
  return target;
}

async function readReceipt(target: string): Promise<Receipt> {
  return JSON.parse(await fs.readFile(path.join(target, "envdoctor-receipt.json"), "utf8")) as Receipt;
}

function makeDiagnosis(overrides: Partial<Diagnosis>): Diagnosis {
  return {
    id: "test", category: "env", severity: "error", title: "test finding", message: "message",
    autoFixable: false, ...overrides,
  };
}

test("a verified repair flips the reproduction from red to green and proves it", async () => {
  const target = await copyFixture("landmine-db-url-app");
  try {
    const outcome = await runOnboard({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });

    assert.equal(outcome.before?.exitCode, 1, "the baseline reproduction must fail");
    assert.equal(outcome.after?.exitCode, 0, "the verified repair must leave the reproduction green");
    assert.equal(outcome.verified, true);

    const receipt = await readReceipt(target);
    assert.equal(receipt.verify.proof, "red-to-green");
    assert.equal(receipt.verdict, "verified-green");
    assert.equal(receipt.verify.after.outcome, "verified-green");
    assert.notEqual(receipt.verify.before.fingerprint, receipt.verify.after.fingerprint);

    // The headline guarantee: a repair is only claimed when it was executed and observed.
    assert.equal(receipt.guarantees.offline, true, "env repairs must not touch the network");
    assert.deepEqual(receipt.guarantees.egress, []);
    assert.equal(receipt.guarantees.secrets.printed, 0, "no secret value may survive into the receipt");
    assert.equal(receipt.guarantees.telemetry, "none");

    // The variable that was only filled with a template value is not claimed as fixed.
    const placeholder = receipt.repairs.find(repair => repair.status === "flagged-placeholder");
    assert.ok(placeholder, "the placeholder repair should be flagged, not counted as verified");
    assert.ok(receipt.escalation.some(entry => entry.findingId === placeholder!.findingId));
    assert.equal(receipt.summary.verified, 1);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("a repair with no measurable effect is rolled back and the real blocker is reported", async () => {
  const target = await copyFixture("false-fix-rollback-app");
  try {
    const before = await fs.readFile(path.join(target, ".env"), "utf8");
    const outcome = await runOnboard({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });

    assert.equal(outcome.after?.exitCode, 1, "the real failure is not an environment variable");
    assert.equal(outcome.repairs.length, 1);
    assert.equal(outcome.repairs[0].status, "rolled-back-no-effect");
    assert.equal(outcome.repairs[0].rolledBack, true);

    const after = await fs.readFile(path.join(target, ".env"), "utf8");
    assert.equal(after, before, "the .env file must be byte-identical after a rolled-back repair");

    const receipt = await readReceipt(target);
    assert.equal(receipt.verdict, "rolled-back");
    assert.equal(receipt.summary.rolledBack, 1);
    const reason = receipt.escalation.map(entry => entry.reason).join("\n");
    assert.match(reason, /no measurable effect/);
    assert.match(reason, /ENOENT|local\.json/, "the report must name the actual blocker");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("revert restores the pre-repair bytes and verifies the undo", async () => {
  const target = await copyFixture("landmine-db-url-app");
  try {
    const before = await fs.readFile(path.join(target, ".env"), "utf8");
    await runOnboard({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
    assert.notEqual(await fs.readFile(path.join(target, ".env"), "utf8"), before, "the repair wrote something");

    const result = await revertSession(target);
    assert.equal(result.success, true);
    assert.equal(result.verified, true, "the undo must be verified against the recorded hashes");
    assert.equal(await fs.readFile(path.join(target, ".env"), "utf8"), before);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("failure fingerprints are stable across paths and timestamps", () => {
  const first = normalizeOutput(
    "2026-09-12T10:11:12.999Z ERROR failed at /home/dev/app/src/db.js in 128ms\nNode v20.20.2 pid=4242 localhost:5432\n",
    { cwd: "/home/dev/app" },
  ).text;
  const second = normalizeOutput(
    "2026-01-02T03:04:05.123Z ERROR failed at /home/ci/work/src/db.js in 940ms\nNode v20.20.2 pid=99 localhost:5432\n",
    { cwd: "/home/ci/work" },
  ).text;
  assert.equal(first, second, "the same failure on two machines must produce one fingerprint");
  assert.match(first, /<ts>|<time>|<duration>|<root>/);
});

test("secret values are redacted out of captured output", () => {
  const secret = "postgres://user:hunter2@db.internal:5432/app";
  const { text, redactions } = normalizeOutput(`connecting to ${secret}\nboom\n`, { cwd: "/app", secrets: [secret] });
  assert.equal(redactions, 1);
  assert.equal(text.includes("hunter2"), false);
});

test("policy waivers suppress by pattern, and an expired waiver re-activates the finding", async () => {
  const target = await copyFixture("policy-waivers-app");
  try {
    const { loadPolicy } = await import("../config.js");
    const policy = await loadPolicy(target);
    const result = await scanAll(target);
    const outcome = applyPolicy(result.diagnoses, policy);

    assert.equal(outcome.active.length, 1);
    assert.equal(outcome.active[0].id, "missing-env-var:LEGACY_TOKEN", "the lapsed waiver must let the finding through");
    assert.ok(outcome.waivered.some(item => item.id.startsWith("env-mismatch:API_URL")));
    assert.ok(outcome.ignored.some(item => item.category === "runtime"));
    assert.deepEqual(outcome.expiredWaivers, [{ id: "missing-env-var:LEGACY_TOKEN", expires: "2026-01-01" }]);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("SARIF output carries locations and turns waivers into suppressions", () => {
  const sarif = toSarif({
    targetDir: "/tmp/app",
    scannedAt: new Date(0).toISOString(),
    diagnoses: [
      makeDiagnosis({ id: "env-mismatch:DB_URL:src/db.ts:14", file: "src/db.ts", line: 14, severity: "error", autoFixable: true }),
      makeDiagnosis({ id: "placeholder-env-value:API_KEY", severity: "warning", waivered: { by: "security", reason: "rotation pending", expires: "2099-01-01" } }),
    ],
  }, { exitCode: 1 });

  const run = (sarif.runs as Array<Record<string, unknown>>)[0];
  const results = run.results as Array<Record<string, unknown>>;
  assert.equal(sarif.version, "2.1.0");
  assert.equal(results.length, 2);
  const location = (results[0].locations as Array<Record<string, unknown>>)[0] as { physicalLocation: { region: { startLine: number } } };
  assert.equal(location.physicalLocation.region.startLine, 14);
  assert.deepEqual(results[1].suppressions, [{ kind: "external", justification: "security: rotation pending (expires 2099-01-01)" }]);
  assert.equal(((run.invocations as Array<Record<string, unknown>>)[0] as { exitCode: number }).exitCode, 1);
});

test("fingerprints are reproducible, and the diff names the drifts", async () => {
  const target = await copyFixture("landmine-db-url-app");
  try {
    const here = await buildFingerprint({ targetDir: target });
    const again = await buildFingerprint({ targetDir: target });
    assert.equal(here.id, again.id, "the same machine and repo must produce the same fingerprint id");

    // Simulate CI: a different runtime, and a different value for the same variable.
    const there = JSON.parse(JSON.stringify(here)) as typeof here;
    there.id = "fp_ci";
    there.runtime.node = "22.11.0";
    const row = there.env.find(item => item.key === "DATABASE_URL");
    if (row) row.valueHash = "sha256:000000000000";

    const rows = diffFingerprints(here, there);
    assert.ok(rows.some(item => item.section === "runtime" && item.key === "node"));
    assert.ok(rows.some(item => item.section === "env" && item.key === "DATABASE_URL"));
    assert.equal(JSON.stringify(here).includes("sslmode=require"), false, "fingerprints must never contain env values");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("placeholder detection flags templates without crying wolf about real hosts", () => {
  assert.equal(looksLikePlaceholder("<REPLACE_ME>"), true);
  assert.equal(looksLikePlaceholder("changeme"), true);
  assert.equal(looksLikePlaceholder("demo-token"), true);
  assert.equal(looksLikePlaceholder("https://api.example.test"), true);
  assert.equal(looksLikePlaceholder("postgres://localhost:5432/app?sslmode=require"), false);
  assert.equal(looksLikePlaceholder("https://billing.svc.internal:8443"), false);
});
