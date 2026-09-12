import { promises as fs } from "node:fs";
import path from "node:path";
import { filesTouchedBy, fixDiagnosis } from "../fixers/index.js";
import { Transaction } from "../fixers/transaction.js";
import { applyPolicy } from "../policy.js";
import { scanAll } from "../scanners/index.js";
import { hashFile, hashTree, sha256 } from "../util/hash.js";
import { detectVerifyCommand, failureChanged, reproPassed, runRepro } from "../verify/repro.js";
import { buildReceipt, collectSecretValues, receiptHeadline, writeReceipt } from "../verify/receipt.js";
/** Resolves the reproduction command: explicit policy first, then the project's own script. */
export async function resolveVerify(targetDir, policy) {
    if (policy.verify.command) {
        const [command, ...args] = policy.verify.command.split(/\s+/).filter(Boolean);
        return { command, args, source: "policy" };
    }
    try {
        const manifest = JSON.parse(await fs.readFile(path.join(targetDir, "package.json"), "utf8"));
        const detected = detectVerifyCommand(manifest);
        if (detected)
            return { ...detected, source: "package.json" };
    }
    catch {
        /* no manifest */
    }
    return undefined;
}
/**
 * The verified repair pipeline.
 *
 *   1. run the project's reproduction command and record the failure
 *   2. for each safely-fixable finding: snapshot → repair → re-run the reproduction
 *   3. keep the repair only if it *measurably* changed the outcome; otherwise undo it
 *   4. emit a receipt that states what changed, what was proven, and what was refused
 *
 * The rule that makes this different from a suggestion: a repair that cannot be
 * shown to change anything is taken back, and the real failure is handed back to you.
 */
export async function runOnboard(options) {
    const targetDir = path.resolve(options.targetDir);
    const log = options.log ?? (() => { });
    const policy = options.policy;
    const expect = policy.verify.expectExitCode;
    const resolved = await resolveVerify(targetDir, policy);
    if (!resolved) {
        throw new Error("No reproduction command found. Add a `preflight` script to package.json, or set `verify.command` in .envdoctor.yml.");
    }
    const verifyCommand = [resolved.command, ...resolved.args].join(" ");
    const secrets = await collectSecretValues(targetDir);
    const scanBefore = await scanAll(targetDir);
    const outcome = applyPolicy(scanBefore.diagnoses, policy);
    const findingsBefore = outcome.active;
    log(`▶ reproduction: ${verifyCommand}`);
    const fileHashesBefore = await hashTree(targetDir);
    const before = await runRepro({
        command: resolved.command, args: resolved.args, cwd: targetDir,
        timeoutMs: policy.verify.timeoutMs, secrets,
    });
    const redacted = before.redactions;
    log(`  baseline exit ${before.exitCode ?? "null"} in ${before.durationMs}ms · fingerprint ${before.fingerprint.slice(0, 12)}`);
    if (options.dryRun) {
        return {
            verifyCommand, scanBefore, scanAfter: scanBefore, before, repairs: budget(options, findingsBefore, before), escalations: [],
            summary: "Dry run — no files were changed.", verified: false,
        };
    }
    const wanted = (diagnosis) => options.repairClass === "all" || diagnosis.category === "env";
    const queue = findingsBefore.filter(diagnosis => diagnosis.autoFixable && wanted(diagnosis));
    const session = new Transaction(targetDir, `verified repair (${verifyCommand})`);
    const repairs = [];
    const escalations = [];
    const egress = [];
    let redactedTotal = redacted;
    let current = before;
    for (const diagnosis of queue) {
        const files = filesTouchedBy(diagnosis);
        await session.snapshotAll(files);
        const repairTx = new Transaction(targetDir, diagnosis.title, session.sessionId);
        await repairTx.snapshotAll(files);
        const hashBefore = repairTx.hashInput();
        log(`▶ repairing: ${diagnosis.title}`);
        const result = await fixDiagnosis(diagnosis, targetDir);
        if (!result.success) {
            await repairTx.rollback();
            repairs.push(record(diagnosis, files, hashBefore, hashBefore, "failed", false, [], result.message));
            escalations.push({ findingId: diagnosis.id, title: diagnosis.title, reason: `Repair failed: ${result.message}` });
            log(`  ✗ ${result.message}`);
            continue;
        }
        if (result.changed === false) {
            repairs.push(record(diagnosis, files, hashBefore, hashBefore, "failed", false, [], result.message));
            log(`  ⏭ ${result.message}`);
            continue;
        }
        const touched = await hashAfter(targetDir, files);
        const installed = diagnosis.details?.manager;
        if (installed === "npm" || installed === "pip") {
            egress.push(`${installed} install ${diagnosis.details?.package ?? ""}`.trim());
        }
        const run = await runRepro({
            command: resolved.command, args: resolved.args, cwd: targetDir,
            timeoutMs: policy.verify.timeoutMs, secrets,
        });
        redactedTotal += run.redactions;
        const placeholders = result.placeholders ?? [];
        const warnings = placeholders.map(item => `injected placeholder value for ${item.key}`);
        if (reproPassed(run, expect)) {
            repairs.push(record(diagnosis, files, hashBefore, touched, "verified-green", false, warnings, result.message, run));
            current = run;
            if (placeholders.length) {
                escalations.push({
                    findingId: diagnosis.id, title: diagnosis.title,
                    reason: `Reproduction is green, but ${placeholders.map(item => item.key).join(", ")} was filled from the template with a placeholder value. Replace it before this reaches a real environment.`,
                });
            }
            log(`  ✅ verified: exit ${current.exitCode} · fingerprint ${run.fingerprint.slice(0, 12)}`);
        }
        else if (placeholders.length) {
            repairs.push(record(diagnosis, files, hashBefore, touched, "flagged-placeholder", false, warnings, result.message, run));
            current = run;
            escalations.push({
                findingId: diagnosis.id, title: diagnosis.title,
                reason: `Injected a placeholder for ${placeholders.map(item => item.key).join(", ")} instead of a real value, so this repair is not counted as verified. A real credential is still required.`,
            });
            log(`  ⚠ placeholder injected — not claimed as verified`);
        }
        else if (failureChanged(current, run)) {
            repairs.push(record(diagnosis, files, hashBefore, touched, "progress-unverified", false, warnings, result.message, run));
            current = run;
            escalations.push({
                findingId: diagnosis.id, title: diagnosis.title,
                reason: `The failure moved but the reproduction is still red: ${run.signature.split("\n")[0] ?? "see the transcript"}`,
            });
            log(`  ◐ progress: exit ${run.exitCode}, failure changed but not green`);
        }
        else {
            const rollback = await repairTx.rollback();
            repairs.push(record(diagnosis, files, hashBefore, rollback.hash, "rolled-back-no-effect", true, warnings, result.message, run));
            escalations.push({
                findingId: diagnosis.id, title: diagnosis.title,
                reason: `Repair had no measurable effect — the reproduction failed identically (exit ${run.exitCode}, fingerprint ${run.fingerprint.slice(0, 12)}), so the change was undone. The real blocker is not an environment variable: ${run.signature.split("\n").join(" — ")}`,
            });
            log(`  ↩ rolled back: no measurable effect · real blocker: ${run.signature.split("\n").join(" · ")}`);
        }
    }
    const scanAfter = await scanAll(targetDir);
    const afterPolicy = applyPolicy(scanAfter.diagnoses, policy);
    const after = current;
    for (const diagnosis of afterPolicy.active.filter(item => !item.autoFixable)) {
        if (escalations.some(entry => entry.findingId === diagnosis.id))
            continue;
        escalations.push({
            findingId: diagnosis.id,
            title: diagnosis.title,
            reason: diagnosis.details?.kind === "placeholder"
                ? `The reproduction may already pass, but ${diagnosis.details.key ?? "this variable"} still holds a template value. A real credential is required.`
                : diagnosis.category === "runtime"
                    ? "Runtime versions disagree. Align .nvmrc / engines / CI, then re-run the reproduction."
                    : "No safe automatic repair exists for this finding — it needs a human decision.",
        });
    }
    const receipt = buildReceipt({
        targetDir,
        verifyCommand,
        expectExitCode: expect,
        before,
        after,
        repairs,
        findingsBefore: findingsBefore.map(item => ({ ...item })),
        findingsAfter: afterPolicy.active,
        fileHashesBefore,
        fileHashesAfter: await hashTree(targetDir),
        egress,
        escalation: escalations,
        secretValues: secrets,
        redactedCount: redactedTotal,
    });
    let receiptPath;
    if (options.writeReceipt !== false) {
        const destination = options.receiptPath ?? policy.receipt.out ?? path.join(targetDir, "envdoctor-receipt.json");
        receiptPath = await writeReceipt(receipt, path.resolve(destination));
        log(`📄 receipt: ${receiptPath}`);
    }
    const keptSomething = repairs.some(repair => !repair.rolledBack);
    if (keptSomething) {
        await session.commit();
        log(`↩ undo with: env-doctor revert ${targetDir}`);
    }
    else {
        await session.discard();
    }
    const verified = receipt.verify.proof === "red-to-green";
    return {
        verifyCommand, scanBefore, scanAfter, before, after, repairs, receipt, receiptPath, escalations,
        summary: receiptHeadline(receipt), verified,
    };
}
function budget(options, findings, before) {
    return findings.filter(item => item.autoFixable && (options.repairClass === "all" || item.category === "env")).map(item => ({
        findingId: item.id,
        title: item.title,
        files: filesTouchedBy(item),
        fixer: item.fixDescription ?? "auto",
        status: "failed",
        beforeHash: "",
        afterHash: "",
        repro: { exitCode: before.exitCode, fingerprint: before.fingerprint },
        rolledBack: false,
        warnings: [],
        message: "planned (dry run)",
    }));
}
function record(diagnosis, files, beforeHash, afterHash, status, rolledBack, warnings, message, run) {
    return {
        findingId: diagnosis.id,
        title: diagnosis.title,
        files,
        fixer: diagnosis.fixDescription ?? diagnosis.details?.kind ?? "auto",
        status,
        beforeHash,
        afterHash,
        repro: run ? { exitCode: run.exitCode, fingerprint: run.fingerprint.slice(0, 16) } : undefined,
        rolledBack,
        warnings,
        message,
    };
}
async function hashAfter(targetDir, files) {
    const payload = await Promise.all(files.map(async (file) => `${file}:${(await hashFile(path.join(targetDir, file))) ?? "absent"}`));
    return sha256(payload.join("|")).slice(0, 16);
}
