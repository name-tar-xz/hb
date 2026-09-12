import chalk from "chalk";
function paint(diagnosis) {
    const icon = diagnosis.severity === "error" ? "❌" : diagnosis.severity === "warning" ? "⚠️ " : "ℹ️ ";
    const color = diagnosis.severity === "error" ? chalk.red : diagnosis.severity === "warning" ? chalk.yellow : chalk.blue;
    const location = diagnosis.file ? ` (${diagnosis.file}${diagnosis.line ? `:${diagnosis.line}` : ""})` : "";
    const waiver = diagnosis.waivered ? chalk.gray(` [waived by ${diagnosis.waivered.by}${diagnosis.waivered.expires ? `, expires ${diagnosis.waivered.expires}` : ""}]`) : "";
    return `${color(`${icon} ${diagnosis.title}`)}${location}${waiver}\n   ${diagnosis.message}`;
}
export function renderReport(result) {
    const unresolved = result.diagnoses.filter(d => !d.fixed);
    if (!unresolved.length)
        return `${chalk.bold("🩺 Env Doctor — Scan Report")}\n${"─".repeat(28)}\n${chalk.green("✅ All clear! Your environment is healthy.")}`;
    const errors = unresolved.filter(d => d.severity === "error").length;
    const warnings = unresolved.filter(d => d.severity === "warning").length;
    const fixable = unresolved.filter(d => d.autoFixable).length;
    return `${chalk.bold("🩺 Env Doctor — Scan Report")}\n${"─".repeat(28)}\n${unresolved.map(paint).join("\n\n")}\n\n${chalk.bold(`Summary: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`)}${fixable ? `\nRun with --fix to auto-resolve ${fixable} of ${unresolved.length} issues.` : ""}`;
}
const STATUS_LABEL = {
    "verified-green": "✅ verified",
    "progress-unverified": "◐ progress",
    "rolled-back-no-effect": "↩ rolled back",
    "flagged-placeholder": "⚠ placeholder",
    failed: "✗ not applied",
};
function statusLine(repair) {
    const label = STATUS_LABEL[repair.status];
    const painted = repair.status === "verified-green" ? chalk.green(label)
        : repair.status === "rolled-back-no-effect" || repair.status === "failed" ? chalk.red(label)
            : chalk.yellow(label);
    const files = repair.files.length ? chalk.gray(` [${repair.files.join(", ")}]`) : "";
    return `  ${painted} ${repair.title}${files}`;
}
function reproBlock(label, run, expect) {
    if (!run)
        return chalk.gray(`${label}: not run`);
    const green = run.exitCode === expect && !run.timedOut;
    const exit = run.timedOut ? chalk.red("timed out") : green ? chalk.green(`exit ${run.exitCode}`) : chalk.red(`exit ${run.exitCode}`);
    const signature = run.signature || run.preview.split("\n").slice(-1)[0] || "";
    const tail = signature ? chalk.gray(`\n      ${signature.split("\n").join("\n      ")}`) : "";
    return `${label}: ${exit} · ${run.durationMs}ms · ${chalk.gray(run.fingerprint.slice(0, 12))}${tail}`;
}
/**
 * The verified report: what the reproduction did *before*, what each repair
 * measurably changed, and the receipt that backs the claim.
 */
export function renderVerifiedReport(outcome, expect = 0) {
    const lines = [];
    lines.push(chalk.bold("🩺 Env Doctor — Verified Repair"));
    lines.push("─".repeat(34));
    lines.push(chalk.gray(`reproduction: ${outcome.verifyCommand}`));
    lines.push("");
    lines.push(chalk.bold("Before"));
    lines.push(`  ${reproBlock("repro", outcome.before, expect)}`);
    lines.push("");
    if (outcome.repairs.length) {
        lines.push(chalk.bold("Repairs (each one re-verified by execution)"));
        for (const repair of outcome.repairs)
            lines.push(statusLine(repair));
        lines.push("");
    }
    lines.push(chalk.bold("After"));
    lines.push(`  ${reproBlock("repro", outcome.after, expect)}`);
    lines.push("");
    if (outcome.escalations.length) {
        lines.push(chalk.bold("Needs a human (refused to guess)"));
        for (const entry of outcome.escalations) {
            lines.push(`  ${chalk.yellow("→")} ${entry.title}`);
            lines.push(chalk.gray(`      ${entry.reason.split("\n").join("\n      ")}`));
        }
        lines.push("");
    }
    const receipt = outcome.receipt;
    if (receipt) {
        const verdict = receipt.verdict === "verified-green" ? chalk.green(receipt.verdict) : chalk.yellow(receipt.verdict);
        lines.push(`${chalk.bold("Verdict:")} ${verdict} · ${receiptHeadlinePlain(receipt)}`);
        lines.push(chalk.gray(`  receipt ${receipt.id} · ${receipt.guarantees.offline ? "offline (0 network calls)" : `egress: ${receipt.guarantees.egress.join(", ")}`} · secrets printed: ${receipt.guarantees.secrets.printed} · redacted: ${receipt.guarantees.secrets.redacted}`));
        if (outcome.receiptPath)
            lines.push(chalk.gray(`  written to ${outcome.receiptPath}`));
    }
    return lines.join("\n");
}
function receiptHeadlinePlain(receipt) {
    const { verify, summary } = receipt;
    return `repro exit ${verify.before.exitCode} → ${verify.after.exitCode} · ${summary.verified} verified · ${summary.rolledBack} rolled back · ${summary.escalated} escalated`;
}
