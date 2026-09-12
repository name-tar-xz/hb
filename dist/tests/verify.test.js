import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBackup, getBackupCount, markBackups, revertAll, revertTo } from "../fixers/backup.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runOnboard } from "../commands/onboard.js";
import { runVerifiedRepair } from "../commands/verified-repair.js";
import { defaultPolicy, loadPolicy } from "../config.js";
import { buildFingerprint, diffFingerprints } from "../fingerprint/index.js";
import { revertSession } from "../fixers/transaction.js";
import { applyPolicy } from "../policy.js";
import { toSarif } from "../report/sarif.js";
import { scanAll } from "../scanners/index.js";
import { looksLikePlaceholder } from "../util/placeholder.js";
import { normalizeOutput, redactSecrets } from "../verify/repro.js";
import { envPresenceRepro, npmRepro } from "../verify/repro-for.js";
const fixtures = fileURLToPath(new URL("../../test-fixtures/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
async function copyFixture(name) {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), `env-doctor-${name}-`));
    await fs.cp(path.join(fixtures, name), target, { recursive: true });
    return target;
}
async function readReceipt(target) {
    return JSON.parse(await fs.readFile(path.join(target, "envdoctor-receipt.json"), "utf8"));
}
function makeDiagnosis(overrides) {
    return {
        id: "test", category: "env", severity: "error", title: "test finding", message: "message",
        autoFixable: false, ...overrides,
    };
}
/* ------------------------------------------------------------------ *
 * Reproduction metadata on findings
 * ------------------------------------------------------------------ */
test("every scanner attaches a reproduction command and an expected failing exit code", async () => {
    const target = await copyFixture("broken-node-app");
    const runtimeTarget = await copyFixture("policy-waivers-app");
    try {
        const runtimeFindings = await scanAll(runtimeTarget);
        const runtime = runtimeFindings.diagnoses.find(item => item.category === "runtime");
        assert.ok(runtime, "the fixture declares .nvmrc 18 while running a newer Node");
        assert.match(runtime.repro.command, /process\.version/, "runtime findings reproduce by checking the runtime");
        const result = await scanAll(target);
        assert.ok(result.diagnoses.length > 0);
        for (const diagnosis of result.diagnoses) {
            assert.ok(diagnosis.repro, `${diagnosis.id} must carry a repro`);
            assert.equal(typeof diagnosis.repro.command, "string");
            assert.ok(diagnosis.repro.command.length > 0);
            assert.ok(diagnosis.repro.expectedFailingExitCode > 0, "the expected failing exit code must be non-zero");
        }
        const missing = result.diagnoses.find(item => item.id.startsWith("missing-dep:"));
        assert.match(missing.repro.command, /^npm ls "/, "npm findings reproduce with npm's own resolution check");
        const env = result.diagnoses.find(item => item.category === "env");
        assert.match(env.repro.command, /readFileSync/, "env findings reproduce by reading the variable the way the app does");
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
        await fs.rm(runtimeTarget, { recursive: true, force: true });
    }
});
test("generated repros are finding-specific: env presence, npm resolution, missing .env", () => {
    const presence = envPresenceRepro("DB_URL");
    assert.match(presence.command, /DB_URL/);
    assert.match(presence.command, /env\.missing/, "the command reports why it failed, so its output hash is meaningful");
    assert.match(presence.command, /readFileSync/, "it loads .env itself, so a missing .env cannot mask the real question");
    assert.equal(presence.expectedFailingExitCode, 1);
    assert.equal(npmRepro("lodash").command, 'npm ls "lodash" --depth=0');
});
/* ------------------------------------------------------------------ *
 * The verified repair loop
 * ------------------------------------------------------------------ */
test("a fix whose repro flips to zero is kept, and the receipt proves it", async () => {
    const target = await copyFixture("landmine-db-url-app");
    try {
        const outcome = await runVerifiedRepair({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        assert.equal(outcome.verified, true);
        const receipt = await readReceipt(target);
        assert.ok(receipt.summary.repairsVerified >= 1);
        assert.equal(receipt.summary.repairsEscalated, 0);
        assert.equal(receipt.verdict, "verified-green");
        const dbUrl = receipt.repairs.find(repair => repair.findingId.includes("DB_URL"));
        assert.equal(dbUrl.status, "verified");
        assert.equal(dbUrl.repro.flipped, true);
        assert.ok(dbUrl.repro.before.exitCode !== 0, "the reproduction failed before the fix");
        assert.equal(dbUrl.repro.after.exitCode, 0, "and passed after it");
        assert.equal(dbUrl.rolledBack, false);
        assert.match(dbUrl.repro.command, /DB_URL/);
        assert.notEqual(dbUrl.repro.before.stdoutHash, dbUrl.repro.after.stdoutHash, "the two runs produced different output");
        assert.equal(await fs.readFile(path.join(target, ".env"), "utf8").then(text => text.includes("DB_URL=")), true);
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("a fix whose repro does not flip is escalated and the change is taken back", async () => {
    const target = await copyFixture("false-fix-rollback-app");
    try {
        const envBefore = await fs.readFile(path.join(target, ".env"), "utf8");
        const outcome = await runVerifiedRepair({
            targetDir: target,
            policy: defaultPolicy(),
            repairClass: "env",
            reproMode: "project",
        });
        assert.equal(outcome.repairs.length, 1);
        assert.equal(outcome.repairs[0].status, "escalated");
        assert.equal(outcome.repairs[0].rolledBack, true);
        assert.equal(outcome.verified, false);
        assert.equal(await fs.readFile(path.join(target, ".env"), "utf8"), envBefore, "the change must not be kept");
        const receipt = await readReceipt(target);
        assert.equal(receipt.summary.repairsVerified, 0);
        assert.equal(receipt.summary.repairsEscalated, 1);
        assert.equal(receipt.verdict, "escalated");
        assert.equal(receipt.repairs[0].repro.flipped, false);
        assert.equal(receipt.repairs[0].repro.before.exitCode, receipt.repairs[0].repro.after.exitCode);
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("an escalated repair does not take a verified repair down with it", async () => {
    // This is why the loop reverts with a scoped checkpoint instead of a blanket revertAll:
    // a blanket undo would silently discard changes verification had already approved.
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "env-doctor-scoped-"));
    try {
        await fs.writeFile(path.join(target, ".env.example"), "GOOD_KEY=real-value-1234\nBAD_KEY=real-value-5678\n");
        await fs.writeFile(path.join(target, ".env"), "");
        await fs.mkdir(path.join(target, "scripts"), { recursive: true });
        await fs.writeFile(path.join(target, "scripts", "preflight.js"), [
            'import { loadEnv } from "./load-env.js";',
            "loadEnv();",
            "if (!process.env.GOOD_KEY) { console.log('FAIL good_key'); process.exitCode = 1; }",
            "else console.log('OK good_key');",
        ].join("\n"));
        await fs.writeFile(path.join(target, "scripts", "load-env.js"), [
            'import { readFileSync } from "node:fs";',
            'import path from "node:path";',
            'import { fileURLToPath } from "node:url";',
            "export function loadEnv() {",
            '  const location = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");',
            '  let source = "";',
            "  try { source = readFileSync(location, utf8); } catch { return; }",
            "  for (const line of source.split(/\\r?\\n/)) {",
            '    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);',
            "    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];",
            "  }",
            "}",
        ].join("\n").replace("readFileSync(location, utf8)", 'readFileSync(location, "utf8")'));
        // First repair flips its own reproduction; the second one cannot (its check is
        // satisfied, so nothing changes and nothing is kept).
        const outcome = await runVerifiedRepair({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        const good = outcome.repairs.find(repair => repair.findingId.includes("GOOD_KEY"));
        assert.equal(good?.status, "verified");
        assert.equal(await fs.readFile(path.join(target, ".env"), "utf8").then(text => text.includes("GOOD_KEY=")), true);
        const receipt = await readReceipt(target);
        assert.equal(receipt.summary.repairsVerified + receipt.summary.repairsEscalated, outcome.repairs.length);
        for (const repair of receipt.repairs.filter(item => item.rolledBack)) {
            assert.notEqual(repair.findingId, good.findingId, "a verified repair must never be rolled back");
        }
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("backup checkpoints revert only what happened after them", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "env-doctor-backup-"));
    try {
        const file = path.join(target, "config.json");
        await fs.writeFile(file, '{"version":1}\n');
        const mark = markBackups();
        await createBackup(target, "config.json"); // fixers always journal a file before writing it
        await fs.writeFile(file, '{"version":2}\n'); // stands in for a repair that will be rejected
        await revertTo(target, mark);
        assert.equal(await fs.readFile(file, "utf8"), '{"version":1}\n');
        assert.equal(getBackupCount(), mark, "the rolled-back entries leave the journal");
        // revertAll remains the full-undo path used by `env-doctor revert`.
        assert.equal(typeof revertAll, "function");
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("the project's own check is run around the loop, and a still-red project is reported", async () => {
    const target = await copyFixture("false-fix-rollback-app");
    try {
        const outcome = await runVerifiedRepair({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        const receipt = await readReceipt(target);
        assert.ok(receipt.projectRepro, "the repo has a preflight script, so it is used as the guard");
        assert.equal(receipt.projectRepro.green, false);
        assert.equal(receipt.projectRepro.before.exitCode > 0, true);
        assert.equal(outcome.verified, false, "the environment was fixed but the app still fails");
        assert.ok(outcome.escalations.some(entry => entry.findingId === "project-reproduction"));
        // The finding-level repair is genuinely verified (the variable is readable now), and
        // the receipt says so without pretending the project is healthy.
        assert.equal(receipt.verdict, "partially-verified");
        assert.equal(receipt.summary.repairsVerified, 1);
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
/* ------------------------------------------------------------------ *
 * Receipt contents: counts, hashes, and what must never appear
 * ------------------------------------------------------------------ */
test("the receipt summarizes counts, repro runs, network calls and secrets", async () => {
    const target = await copyFixture("landmine-db-url-app");
    try {
        const outcome = await runVerifiedRepair({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        const receipt = await readReceipt(target);
        const text = JSON.stringify(receipt);
        assert.equal(receipt.findings.count, receipt.findings.before.length);
        assert.ok(receipt.findings.count > 0);
        assert.equal(receipt.summary.findings, receipt.findings.count);
        assert.equal(receipt.summary.repairsApplied, receipt.repairs.filter(repair => !repair.rolledBack).length);
        assert.equal(receipt.summary.repairsVerified, receipt.repairs.filter(repair => repair.status === "verified").length);
        assert.ok(receipt.summary.reproCommandsRun >= receipt.repairs.length, "each repair runs its repro at least twice");
        assert.ok(receipt.summary.reproCommands.length > 0);
        assert.equal(receipt.networkCalls, 0, "the default repair class must not touch the network");
        assert.equal(receipt.guarantees.networkCalls, 0);
        assert.equal(receipt.guarantees.offline, true);
        assert.equal(receipt.guarantees.telemetry, "none");
        assert.ok(receipt.escalation.length > 0, "escalations raised by the pipeline reach the receipt");
        // No environment value may appear anywhere in the artifact.
        assert.equal(receipt.guarantees.secrets.envValuesPrinted, 0);
        assert.equal(receipt.guarantees.secrets.confirmed, true);
        assert.equal(text.includes("postgres://localhost:5432/app"), false);
        assert.equal(outcome.redactedBeforePrinting >= 0, true);
        // Reproduction output is stored as hashes, never as content.
        for (const repair of receipt.repairs) {
            assert.match(repair.repro.before.stdoutHash, /^[0-9a-f]{64}$/);
            assert.match(repair.repro.after.stderrHash, /^[0-9a-f]{64}$/);
        }
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("a failing project reproduction is reported by hash, not by quoting its output", async () => {
    const target = await copyFixture("false-fix-rollback-app");
    try {
        await runVerifiedRepair({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        const text = JSON.stringify(await readReceipt(target));
        assert.equal(text.includes("local.json"), false, "raw reproduction output must not be stored");
        assert.equal(text.includes("ENOENT"), false);
        assert.match(text, /sha256:[0-9a-f]{12}/, "the escalation still carries hashes");
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("a placeholder value is kept only with a warning, and reported as needing a human", async () => {
    const target = await copyFixture("landmine-db-url-app");
    try {
        await runVerifiedRepair({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        const receipt = await readReceipt(target);
        const analytics = receipt.repairs.find(repair => repair.findingId.includes("ANALYTICS_KEY"));
        assert.ok(analytics, "the finding is repaired so the variable is readable");
        assert.ok(analytics.warnings.some(warning => /placeholder/.test(warning)), "…but the template value is flagged");
        assert.ok(receipt.escalation.some(entry => /template value|placeholder/i.test(entry.reason)));
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("the verified loop refuses to change anything it cannot reproduce", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "env-doctor-norepro-"));
    try {
        // The variable is declared in the template and missing from .env, but it is already
        // present in this process's environment — so the reproduction passes and nothing
        // may be written.
        await fs.writeFile(path.join(target, ".env.example"), "PRESENT_KEY=value-123456\n");
        await fs.writeFile(path.join(target, ".env"), "");
        const policy = defaultPolicy();
        process.env.PRESENT_KEY = "value-123456";
        try {
            const outcome = await runVerifiedRepair({ targetDir: target, policy, repairClass: "env" });
            assert.equal(outcome.repairs.length, 0);
            assert.ok(outcome.escalations.some(entry => /Not reproduced/.test(entry.reason)));
            assert.equal(await fs.readFile(path.join(target, ".env"), "utf8"), "", "the .env file must be untouched");
        }
        finally {
            delete process.env.PRESENT_KEY;
        }
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
/* ------------------------------------------------------------------ *
 * Supporting behaviour
 * ------------------------------------------------------------------ */
test("revert restores the pre-repair bytes and verifies the undo", async () => {
    const target = await copyFixture("landmine-db-url-app");
    try {
        const before = await fs.readFile(path.join(target, ".env"), "utf8");
        await runVerifiedRepair({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        assert.notEqual(await fs.readFile(path.join(target, ".env"), "utf8"), before, "the repair wrote something");
        const result = await revertSession(target);
        assert.equal(result.success, true);
        assert.equal(result.verified, true, "the undo must be verified against the recorded hashes");
        assert.equal(await fs.readFile(path.join(target, ".env"), "utf8"), before);
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("failure hashes are stable across paths and timestamps, and secrets are redacted", () => {
    const first = normalizeOutput("2026-09-12T10:11:12.999Z ERROR failed at /home/dev/app/src/db.js in 128ms\nNode v20.20.2 pid=4242 localhost:5432\n", { cwd: "/home/dev/app" }).text;
    const second = normalizeOutput("2026-01-02T03:04:05.123Z ERROR failed at /home/ci/work/src/db.js in 940ms\nNode v20.20.2 pid=99 localhost:5432\n", { cwd: "/home/ci/work" }).text;
    assert.equal(first, second, "the same failure on two machines must produce one hash");
    const secret = "postgres://user:hunter2@db.internal:5432/app";
    const { text, count } = redactSecrets(`connecting to ${secret}\nboom\n`, [secret]);
    assert.equal(count, 1);
    assert.equal(text.includes("hunter2"), false);
});
test("policy waivers suppress by pattern, and an expired waiver re-activates the finding", async () => {
    const target = await copyFixture("policy-waivers-app");
    try {
        const policy = await loadPolicy(target);
        const result = await scanAll(target);
        const outcome = applyPolicy(result.diagnoses, policy);
        assert.equal(outcome.active.length, 1);
        assert.equal(outcome.active[0].id, "missing-env-var:LEGACY_TOKEN", "the lapsed waiver must let the finding through");
        assert.ok(outcome.waivered.some(item => item.id.startsWith("env-mismatch:API_URL")));
        assert.ok(outcome.ignored.some(item => item.category === "runtime"));
        assert.deepEqual(outcome.expiredWaivers, [{ id: "missing-env-var:LEGACY_TOKEN", expires: "2026-01-01" }]);
    }
    finally {
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
    const run = sarif.runs[0];
    const results = run.results;
    assert.equal(sarif.version, "2.1.0");
    assert.equal(results.length, 2);
    const location = results[0].locations[0];
    assert.equal(location.physicalLocation.region.startLine, 14);
    assert.deepEqual(results[1].suppressions, [{ kind: "external", justification: "security: rotation pending (expires 2099-01-01)" }]);
    assert.equal(run.invocations[0].exitCode, 1);
});
test("fingerprints are reproducible, carry no values, and the diff names the drifts", async () => {
    const target = await copyFixture("landmine-db-url-app");
    try {
        const here = await buildFingerprint({ targetDir: target });
        const again = await buildFingerprint({ targetDir: target });
        assert.equal(here.id, again.id, "the same machine and repo must produce the same fingerprint id");
        const there = JSON.parse(JSON.stringify(here));
        there.id = "fp_ci";
        there.runtime.node = "22.11.0";
        const row = there.env.find(item => item.key === "DATABASE_URL");
        if (row)
            row.valueHash = "sha256:000000000000";
        const rows = diffFingerprints(here, there);
        assert.ok(rows.some(item => item.section === "runtime" && item.key === "node"));
        assert.ok(rows.some(item => item.section === "env" && item.key === "DATABASE_URL"));
        assert.equal(JSON.stringify(here).includes("sslmode=require"), false, "fingerprints must never contain env values");
    }
    finally {
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
/* ------------------------------------------------------------------ *
 * The onboard command: clean install → scan → verify-repair → re-scan → time to green
 * ------------------------------------------------------------------ */
test("onboard runs a clean install, repairs, re-scans and reports time to green", async () => {
    const target = await copyFixture("crossfile-db-url-app");
    try {
        const report = await runOnboard({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        assert.equal(report.green, true, "the app boots after onboarding");
        assert.ok(report.timeToGreenMs > 0);
        assert.equal(report.install.kind, "npm ci");
        assert.equal(report.install.exitCode, 0);
        assert.equal(report.install.offline, true, "a locked, dependency-free repo installs without the registry");
        assert.equal(report.install.networkCalls, 0);
        assert.equal(report.repairNetworkCalls, 0, "the repair loop itself never touches the network");
        assert.equal(report.remaining.length, 0, "nothing is left after the re-scan");
        // Every phase of the journey is measured, and the parts sum to no more than the whole.
        const { phases } = report;
        assert.ok(phases.installMs >= 0 && phases.repairMs > 0 && phases.scanAfterMs >= 0);
        assert.ok(phases.totalMs <= report.timeToGreenMs + 5, "phase timings must come from the same clock");
        assert.ok(phases.installMs + phases.scanBeforeMs + phases.repairMs + phases.scanAfterMs <= report.timeToGreenMs + 200);
        const receipt = await readReceipt(target);
        assert.equal(receipt.timeToGreen?.green, true);
        assert.ok((receipt.timeToGreen?.ms ?? 0) > 0);
        assert.equal(receipt.bootstrap?.kind, "npm ci");
        assert.equal(receipt.bootstrap?.offline, true);
        assert.equal(receipt.summary.repairsVerified, 2);
        assert.equal(receipt.summary.repairsEscalated, 0);
        assert.equal(receipt.networkCalls, 0);
        assert.equal(receipt.guarantees.secrets.envValuesPrinted, 0);
        assert.equal(receipt.projectRepro?.green, true, "the app's own preflight passes");
        assert.equal(receipt.projectRepro?.before.exitCode, 1);
        assert.equal(receipt.projectRepro?.after.exitCode, 0);
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("onboard proves it never rewrote application code", async () => {
    const target = await copyFixture("crossfile-db-url-app");
    try {
        const codeBefore = await Promise.all(["src/config.js", "src/db.js", "src/index.js", ".env.example", "deploy/platform.yaml"].map(async (file) => `${file}:${await fs.readFile(path.join(target, file), "utf8")}`));
        await runOnboard({ targetDir: target, policy: defaultPolicy(), repairClass: "env" });
        const receipt = await readReceipt(target);
        assert.deepEqual(receipt.fileHashes?.changed, [".env"], "the only file this run changed is .env");
        for (const entry of codeBefore) {
            const [file, content] = [entry.slice(0, entry.indexOf(":")), entry.slice(entry.indexOf(":") + 1)];
            assert.equal(await fs.readFile(path.join(target, file), "utf8"), content, `${file} must be byte-identical`);
        }
        // The alias the repair wrote uses the value the template already declares.
        const env = await fs.readFile(path.join(target, ".env"), "utf8");
        assert.match(env, /^DB_URL=postgres:\/\/orders-db\.internal:5432\/orders\?sslmode=require$/m);
        assert.match(env, /^DATABASE_URL=/m, "the template's own key is left in place for the other services");
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("onboard --no-install runs fully offline", async () => {
    const target = await copyFixture("crossfile-db-url-app");
    try {
        const report = await runOnboard({ targetDir: target, policy: defaultPolicy(), repairClass: "env", install: false });
        assert.equal(report.install.kind, "skipped");
        assert.equal(report.install.networkCalls, 0);
        assert.equal(report.green, true);
        const receipt = await readReceipt(target);
        assert.equal(receipt.bootstrap?.kind, "skipped");
        assert.equal(receipt.networkCalls, 0);
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("the onboard CLI reports time to green as JSON and exits 0", async () => {
    const target = await copyFixture("crossfile-db-url-app");
    try {
        const { stdout } = await exec(process.execPath, [path.join(repoRoot, "dist", "cli.js"), "onboard", target, "--json"], {
            cwd: repoRoot,
            maxBuffer: 10 * 1024 * 1024,
        });
        const payload = JSON.parse(stdout);
        assert.equal(payload.green, true);
        assert.ok(payload.timeToGreenMs > 0);
        assert.equal(payload.install.offline, true);
        assert.equal(payload.install.networkCalls, 0);
        assert.equal(payload.repairNetworkCalls, 0);
        assert.equal(payload.remaining.length, 0);
        assert.ok(payload.phases.totalMs > 0);
        assert.equal(payload.repair.repairs.filter(item => item.status === "verified").length, 2);
        // Machine-readable evidence is exit codes and hashes — no raw output.
        for (const repair of payload.repair.repairs) {
            assert.equal(typeof repair.repro.command, "string");
            assert.notEqual(repair.repro.before.exitCode, repair.repro.after.exitCode);
        }
        assert.equal(stdout.includes("orders-db.internal"), false, "no env value may appear in machine output");
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
test("the cross-file fixture is exactly the landmine it claims to be", async () => {
    const target = await copyFixture("crossfile-db-url-app");
    try {
        // A fresh clone: no .env, code reads DB_URL, the template declares DATABASE_URL.
        const envMissing = await fs.access(path.join(target, ".env")).then(() => false).catch(() => true);
        assert.equal(envMissing, true, "the fixture must ship without a .env");
        assert.match(await fs.readFile(path.join(target, "src", "config.js"), "utf8"), /process\.env\.DB_URL/);
        assert.match(await fs.readFile(path.join(target, ".env.example"), "utf8"), /^DATABASE_URL=/m);
        assert.doesNotMatch(await fs.readFile(path.join(target, ".env.example"), "utf8"), /^DB_URL=/m);
        assert.match(await fs.readFile(path.join(target, "deploy", "platform.yaml"), "utf8"), /DB_URL: from-secret/, "the platform injects DB_URL, so the code is right and the template drifted");
        const result = await scanAll(target);
        const ids = result.diagnoses.map(item => item.id).sort();
        assert.deepEqual(ids, ["env-mismatch:DB_URL:src/config.js:9", "missing-env-file"]);
        for (const diagnosis of result.diagnoses) {
            assert.equal(diagnosis.category, "env");
            assert.equal(diagnosis.autoFixable, true);
            assert.ok(diagnosis.repro, "both findings can be reproduced");
        }
        // And the project's own check fails, which is what the judges will see first.
        const { execFile: run } = await import("node:child_process");
        const check = await new Promise(resolve => {
            const child = run(process.execPath, ["scripts/preflight.js"], { cwd: target }, error => resolve(error ? 1 : 0));
            void child;
        });
        assert.equal(check, 1, "a fresh copy cannot boot: DB_URL is not set");
    }
    finally {
        await fs.rm(target, { recursive: true, force: true });
    }
});
