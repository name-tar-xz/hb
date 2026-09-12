#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { runOnboard } from "./commands/onboard.js";
import { loadPolicy } from "./config.js";
import { buildFingerprint, diffFingerprints } from "./fingerprint/index.js";
import { fixDiagnosis } from "./fixers/index.js";
import { latestSession, listSessions, readSession, revertSession } from "./fixers/transaction.js";
import { applyPolicy, evaluateGate } from "./policy.js";
import { renderReport, renderVerifiedReport } from "./report/printer.js";
import { toSarif } from "./report/sarif.js";
import { scanAll } from "./scanners/index.js";
import { startServer } from "./server.js";
import { TOOL_VERSION } from "./verify/receipt.js";
const program = new Command();
const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
function fail(message) {
    console.error(chalk.red(`error: ${message}`));
    process.exit(EXIT_USAGE);
}
program.name("env-doctor")
    .description("Verify a codebase's environment: detect, reproduce, repair, re-verify, receipt.")
    .version(TOOL_VERSION)
    .argument("[path]", "directory to scan")
    .option("--onboard", "verified repair pipeline: reproduce → repair → re-verify → receipt")
    .option("--verify", "alias for --onboard")
    .option("--fix", "apply safe fixes")
    .option("--dry-run", "show what would change without writing anything")
    .option("--json", "print machine-readable JSON")
    .option("--sarif", "print SARIF 2.1.0 to stdout")
    .option("--sarif-out <file>", "write SARIF 2.1.0 to a file (for code-scanning uploads)")
    .option("--policy <file>", "use an explicit policy file instead of .envdoctor.yml")
    .option("--fail-on <severity>", "error | warning | info | none (default: error)")
    .option("--repairs <class>", "env | all — repair classes the verified loop may apply (default: env)")
    .option("--repro <source>", "finding | project — which reproduction to run per finding (default: each finding's own)")
    .option("--receipt-out <file>", "where to write envdoctor-receipt.json")
    .option("--no-receipt", "do not write a receipt")
    .option("--ui", "open the local web interface")
    .action(async (input, options) => {
    if (!input && !options.ui && !options.onboard && !options.verify) {
        fail("missing required argument 'path'");
    }
    const targetDir = path.resolve(input ?? ".");
    if (options.ui)
        return startServer(targetDir);
    let policy;
    try {
        policy = await loadPolicy(targetDir, options.policy);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : "policy could not be loaded");
    }
    if (typeof options.failOn === "string") {
        if (options.failOn !== "none" && options.failOn !== "error" && options.failOn !== "warning" && options.failOn !== "info") {
            fail(`invalid --fail-on value "${options.failOn}"`);
        }
        policy.failOn = options.failOn;
    }
    const repairClass = options.repairs === "all" ? "all" : "env";
    /** Notices go to stderr in machine-readable mode so stdout stays parseable. */
    const note = (line) => (options.json || options.sarif ? console.error(line) : console.log(line));
    /* ---------------- verified repair pipeline ---------------- */
    if (options.onboard || options.verify) {
        try {
            if (options.repro !== undefined && options.repro !== "finding" && options.repro !== "project") {
                fail(`invalid --repro value "${options.repro}"`);
            }
            const outcome = await runOnboard({
                targetDir,
                policy,
                repairClass,
                reproMode: options.repro ?? policy.verify.repro,
                dryRun: Boolean(options.dryRun),
                writeReceipt: options.receipt !== false,
                receiptPath: options.receiptOut,
                log: options.json ? () => { } : line => console.log(chalk.gray(line)),
            });
            if (options.json)
                console.log(JSON.stringify(machineOutcome(outcome), null, 2));
            else
                console.log(`\n${renderVerifiedReport(outcome)}`);
            process.exitCode = outcome.receipt?.verdict === "verified-green" ? EXIT_OK : EXIT_FINDINGS;
        }
        catch (error) {
            fail(error instanceof Error ? error.message : "verified repair failed");
        }
        return;
    }
    /* ---------------- scan (with optional fix) ---------------- */
    let result = await scanAll(targetDir);
    let outcome = applyPolicy(result.diagnoses, policy);
    if (options.sarif || options.sarifOut) {
        const sarif = toSarif({ ...result, diagnoses: outcome.active }, { exitCode: evaluateGate(outcome.active, policy).code });
        const destination = options.sarifOut;
        if (destination) {
            await fs.writeFile(path.resolve(destination), `${JSON.stringify(sarif, null, 2)}\n`);
            note(`SARIF written to ${path.resolve(destination)} (${outcome.active.length} findings)`);
        }
        else {
            console.log(JSON.stringify(sarif, null, 2));
            process.exitCode = evaluateGate(outcome.active, policy).code;
            return;
        }
    }
    if (options.dryRun) {
        if (options.json)
            console.log(JSON.stringify(result, null, 2));
        else {
            console.log(renderReport(result));
            const fixable = outcome.active.filter(d => d.autoFixable);
            if (fixable.length)
                console.log(`\nDry run — no files were changed:\n${fixable.map(d => `• ${d.fixDescription}`).join("\n")}`);
        }
    }
    else if (options.fix) {
        for (const diagnosis of outcome.active.filter(d => d.autoFixable)) {
            if (repairClass === "env" && diagnosis.category !== "env")
                continue;
            if (!options.json)
                console.log(`\nFixing: ${diagnosis.title}`);
            const fixed = await fixDiagnosis(diagnosis, targetDir, line => { if (!options.json && line)
                process.stdout.write(`${line}\n`); });
            if (!options.json)
                console.log(fixed.success ? `✓ ${fixed.message}` : `✗ ${fixed.message}`);
        }
        result = await scanAll(targetDir);
        outcome = applyPolicy(result.diagnoses, policy);
        if (options.json)
            console.log(JSON.stringify({ ...result, diagnoses: outcome.active }, null, 2));
        else
            console.log(`\n${renderReport({ ...result, diagnoses: outcome.active })}`);
    }
    else if (!options.sarif && !options.sarifOut) {
        console.log(options.json ? JSON.stringify({ ...result, diagnoses: outcome.active }, null, 2) : renderReport({ ...result, diagnoses: outcome.active }));
    }
    if (outcome.ignored.length) {
        note(chalk.gray(`${outcome.ignored.length} finding(s) ignored by policy${policy.source ? ` (${policy.source})` : ""}.`));
    }
    if (outcome.waivered.length) {
        note(chalk.gray(`${outcome.waivered.length} finding(s) waivered.`));
    }
    for (const expired of outcome.expiredWaivers) {
        note(chalk.yellow(`⚠ waiver "${expired.id}" expired on ${expired.expires} — the finding is active again.`));
    }
    const gate = evaluateGate(outcome.active, policy);
    process.exitCode = gate.code;
});
/**
 * Machine-readable outcome. Reproduction evidence is exit codes and hashes only:
 * the in-memory failure signatures used for the terminal never leave this process.
 */
function machineOutcome(outcome) {
    return {
        reproMode: outcome.reproMode,
        verified: outcome.verified,
        summary: outcome.summary,
        projectRepro: outcome.projectRepro
            ? {
                command: outcome.projectRepro.spec.command,
                before: { exitCode: outcome.projectRepro.before.exitCode, stdoutHash: outcome.projectRepro.before.stdoutHash, stderrHash: outcome.projectRepro.before.stderrHash },
                after: outcome.projectRepro.after
                    ? { exitCode: outcome.projectRepro.after.exitCode, stdoutHash: outcome.projectRepro.after.stdoutHash, stderrHash: outcome.projectRepro.after.stderrHash }
                    : null,
            }
            : null,
        repairs: outcome.repairs.map(repair => ({
            findingId: repair.findingId,
            title: repair.title,
            status: repair.status,
            files: repair.files,
            rolledBack: repair.rolledBack,
            warnings: repair.warnings,
            repro: repair.repro,
        })),
        escalations: outcome.escalations,
        receipt: outcome.receipt ?? null,
    };
}
program.command("fingerprint")
    .description("print a hashable fingerprint of this environment (runtime, resolved deps, env value hashes)")
    .argument("[path]", "directory to fingerprint", ".")
    .option("--out <file>", "write the fingerprint to a file")
    .option("--diff <file>", "compare against another fingerprint (dev vs CI, prod vs stage)")
    .action(async (input, options) => {
    const targetDir = path.resolve(input);
    const policy = await loadPolicy(targetDir);
    const here = await buildFingerprint({ targetDir, policy });
    const serialized = `${JSON.stringify(here, null, 2)}\n`;
    if (options.out) {
        await fs.writeFile(path.resolve(options.out), serialized);
        console.log(`Fingerprint ${chalk.cyan(here.id)} written to ${path.resolve(options.out)}`);
    }
    else if (!options.diff) {
        console.log(serialized.trimEnd());
    }
    if (!options.diff)
        return;
    let there;
    try {
        there = JSON.parse(await fs.readFile(path.resolve(options.diff), "utf8"));
    }
    catch (error) {
        fail(`could not read fingerprint ${options.diff}: ${error instanceof Error ? error.message : "unreadable"}`);
    }
    const rows = diffFingerprints(here, there);
    if (!rows.length) {
        console.log(chalk.green(`\n✅ Environments agree — fingerprint ${here.id} matches ${there.id}.`));
        process.exitCode = EXIT_OK;
        return;
    }
    console.log(chalk.bold(`\n✗ Environments differ — ${here.id} vs ${there.id}\n`));
    const width = Math.max(...rows.map(row => row.key.length), 4);
    for (const row of rows) {
        console.log(`  ${chalk.bold(row.section.padEnd(10))} ${row.key.padEnd(width)}  ${chalk.cyan(String(row.here))} ${chalk.gray("≠")} ${chalk.magenta(String(row.there))}`);
    }
    console.log(chalk.gray("\nThis is the diff behind \"works on my machine\"."));
    process.exitCode = EXIT_FINDINGS;
});
program.command("revert")
    .description("undo the most recent verified repair session, byte for byte")
    .argument("[path]", "directory whose session should be reverted", ".")
    .option("--session <id>", "revert a specific session id")
    .option("--list", "list recorded sessions")
    .action(async (input, options) => {
    const targetDir = path.resolve(input);
    if (options.list) {
        const sessions = await listSessions(targetDir);
        if (!sessions.length)
            return void console.log("No repair sessions recorded.");
        for (const sessionId of sessions) {
            const manifest = await readSession(targetDir, sessionId);
            console.log(`${sessionId}  ${manifest?.label ?? "(unreadable)"}  ${manifest?.entries.length ?? 0} file(s)`);
        }
        return;
    }
    const manifest = options.session ? await readSession(targetDir, options.session) : await latestSession(targetDir);
    if (!manifest) {
        console.log("No repair session was found to revert.");
        process.exitCode = EXIT_FINDINGS;
        return;
    }
    const result = await revertSession(targetDir, manifest.sessionId);
    console.log(result.verified === false ? chalk.yellow(result.message) : chalk.green(`↩ ${result.message}`));
    for (const file of result.restored)
        console.log(chalk.gray(`  restored ${file}`));
    process.exitCode = result.success ? EXIT_OK : EXIT_FINDINGS;
});
program.parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = EXIT_USAGE;
});
