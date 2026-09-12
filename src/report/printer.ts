import chalk from "chalk";
import { Diagnosis, Receipt, RepairRecord, ReproEvidence, ReproRun, ScanResult } from "../types.js";
import { VerifiedRepairOutcome } from "../commands/verified-repair.js";
import { OnboardReport } from "../commands/onboard.js";

function paint(diagnosis: Diagnosis): string {
  const icon = diagnosis.severity === "error" ? "❌" : diagnosis.severity === "warning" ? "⚠️ " : "ℹ️ ";
  const color = diagnosis.severity === "error" ? chalk.red : diagnosis.severity === "warning" ? chalk.yellow : chalk.blue;
  const location = diagnosis.file ? ` (${diagnosis.file}${diagnosis.line ? `:${diagnosis.line}` : ""})` : "";
  const waiver = diagnosis.waivered ? chalk.gray(` [waived by ${diagnosis.waivered.by}${diagnosis.waivered.expires ? `, expires ${diagnosis.waivered.expires}` : ""}]`) : "";
  const repro = diagnosis.repro ? chalk.gray(`\n   repro: ${diagnosis.repro.command}`) : "";
  return `${color(`${icon} ${diagnosis.title}`)}${location}${waiver}\n   ${diagnosis.message}${repro}`;
}

export function renderReport(result: ScanResult): string {
  const unresolved = result.diagnoses.filter(d => !d.fixed);
  if (!unresolved.length) return `${chalk.bold("🩺 Env Doctor — Scan Report")}\n${"─".repeat(28)}\n${chalk.green("✅ All clear! Your environment is healthy.")}`;
  const errors = unresolved.filter(d => d.severity === "error").length;
  const warnings = unresolved.filter(d => d.severity === "warning").length;
  const fixable = unresolved.filter(d => d.autoFixable).length;
  const commands = new Set(unresolved.map(d => d.repro?.command).filter(Boolean)).size;
  return `${chalk.bold("🩺 Env Doctor — Scan Report")}\n${"─".repeat(28)}\n${unresolved.map(paint).join("\n\n")}\n\n${chalk.bold(`Summary: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`)}${fixable ? `\nRun with --onboard to verify ${fixable} of ${unresolved.length} issues (${commands} reproduction${commands === 1 ? "" : "s"} available).` : ""}`;
}

const STATUS_LABEL: Record<RepairRecord["status"], string> = {
  verified: "✅ verified",
  escalated: "↩ escalated",
};

function exitCode(exit: number | null, timedOut: boolean): string {
  if (timedOut) return chalk.red("timed out");
  if (exit === 0) return chalk.green("0");
  return chalk.red(String(exit));
}

function reproEvidence(label: string, run: ReproRun | undefined, evidenceOnly?: ReproEvidence): string {
  if (!run && !evidenceOnly) return chalk.gray(`${label}: not run`);
  const exit = run ? exitCode(run.exitCode, run.timedOut) : exitCode(evidenceOnly!.exitCode, evidenceOnly!.timedOut);
  const duration = run ? `${run.durationMs}ms · ` : "";
  const hash = (run ?? evidenceOnly!).stdoutHash.slice(0, 12);
  const signature = run?.signature ? chalk.gray(`\n      ${run.signature.split("\n").join("\n      ")}`) : "";
  return `${label}: exit ${exit} · ${duration}stdout ${hash}${signature}`;
}

function repairLine(repair: RepairRecord): string[] {
  const label = repair.status === "verified" ? chalk.green(STATUS_LABEL[repair.status]) : chalk.yellow(STATUS_LABEL[repair.status]);
  const lines = [`  ${label} ${repair.title}${repair.files.length ? chalk.gray(` [${repair.files.join(", ")}]`) : ""}`];
  lines.push(chalk.gray(`      ❯ ${repair.repro.command}`));
  lines.push(
    chalk.gray(
      `      exit ${repair.repro.before.exitCode} → ${repair.repro.after.exitCode}`
      + `${repair.repro.flipped ? " (flipped)" : repair.repro.failureMoved ? " (moved, not cleared)" : " (identical)"}`
      + ` · stdout sha256:${repair.repro.after.stdoutHash.slice(0, 12)}`,
    ),
  );
  if (repair.rolledBack) lines.push(chalk.yellow(`      change reverted — nothing unproven was kept`));
  for (const warning of repair.warnings) lines.push(chalk.yellow(`      ⚠ ${warning}`));
  return lines;
}

/**
 * The verified report: the reproduction command per repair, the exit codes either side
 * of the fix, what was kept, what was taken back, and the receipt that backs it up.
 * Raw reproduction output is shown here (it is your terminal) and never in the receipt.
 */
export function renderVerifiedReport(outcome: VerifiedRepairOutcome): string {
  const lines: string[] = [];
  const receipt = outcome.receipt;
  lines.push(chalk.bold("🩺 Env Doctor — Verified Repair"));
  lines.push("─".repeat(34));
  lines.push(chalk.gray(`reproduction source: ${outcome.reproMode === "project" ? "the project's own script" : "one command per finding"}`));
  lines.push("");

  if (outcome.repairs.length) {
    lines.push(chalk.bold("Repairs (kept only when the reproduction flipped to zero)"));
    for (const repair of outcome.repairs) lines.push(...repairLine(repair));
    lines.push("");
  }

  if (outcome.projectRepro) {
    lines.push(chalk.bold(`Project reproduction: ${outcome.projectRepro.spec.command}`));
    lines.push(`  ${reproEvidence("before", outcome.projectRepro.before)}`);
    if (outcome.projectRepro.after) lines.push(`  ${reproEvidence("after", outcome.projectRepro.after)}`);
    lines.push("");
  }

  if (outcome.escalations.length) {
    lines.push(chalk.bold("Needs a human (refused to guess)"));
    for (const entry of outcome.escalations) {
      lines.push(`  ${chalk.yellow("→")} ${entry.title}`);
      lines.push(chalk.gray(`      ${entry.reason.split("\n").join("\n      ")}`));
    }
    lines.push("");
  }

  if (receipt) {
    const verdict = receipt.verdict === "verified-green" ? chalk.green(receipt.verdict) : chalk.yellow(receipt.verdict);
    lines.push(`${chalk.bold("Verdict:")} ${verdict} · ${headline(receipt)}`);
    lines.push(
      chalk.gray(
        `  receipt ${receipt.id} · ${receipt.guarantees.offline ? "offline" : `egress: ${receipt.networkCalls} call(s)`}`
        + ` · network calls: ${receipt.networkCalls}`
        + ` · env values printed: ${receipt.guarantees.secrets.envValuesPrinted}`
        + ` · redacted before printing: ${receipt.guarantees.secrets.redactedBeforePrinting}`
        + ` · telemetry: ${receipt.guarantees.telemetry}`,
      ),
    );
    if (outcome.receiptPath) lines.push(chalk.gray(`  written to ${outcome.receiptPath}`));
  }
  return lines.join("\n");
}

function headline(receipt: Receipt): string {
  const { summary } = receipt;
  return `${receipt.findings.count} findings · ${summary.repairsApplied} applied · ${summary.repairsVerified} verified · ${summary.repairsEscalated} escalated · ${summary.reproCommandsRun} repro run${summary.reproCommandsRun === 1 ? "" : "s"}`;
}

/**
 * The onboard report: the five phases with what each one cost, and the headline the
 * judges asked for — time to green.
 */
export function renderOnboardReport(report: OnboardReport): string {
  const lines: string[] = [];
  const seconds = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const pad = (label: string) => label.padEnd(18);

  lines.push(chalk.bold("🩺 Env Doctor — Onboard"));
  lines.push("─".repeat(46));
  lines.push(chalk.gray(`target: ${report.target}`));
  lines.push("");

  const installDetail = report.install.kind === "skipped"
    ? chalk.gray("skipped")
    : `${report.install.exitCode === 0 ? chalk.green("✔") : chalk.red(`✖ exit ${report.install.exitCode}`)} ${chalk.gray(report.install.command ?? "")}${
        report.install.offline ? chalk.gray(" · offline") : chalk.gray(` · ${report.install.networkCalls} network call(s)`)
      }`;
  lines.push(`  ${pad("clean install")} ${seconds(report.phases.installMs).padStart(6)}   ${installDetail}`);
  lines.push(`  ${pad("scan")} ${seconds(report.phases.scanBeforeMs).padStart(6)}   ${report.scanBefore.diagnoses.length} finding(s)`);

  if (report.repair && report.repair.repairs.length) {
    const verified = report.repair.repairs.filter(item => item.status === "verified").length;
    const escalated = report.repair.repairs.filter(item => item.status === "escalated").length;
    lines.push(`  ${pad("verify-repair")} ${seconds(report.phases.repairMs).padStart(6)}   ${verified} verified · ${escalated} escalated · ${chalk.gray(`${report.repair.summary.split(" · ").slice(-1)[0]}`)}`);
    for (const repair of report.repair.repairs) {
      const mark = repair.status === "verified" ? chalk.green("✅ verified") : chalk.yellow("↩ escalated");
      lines.push(chalk.gray(`        ${mark} ${repair.title}`));
      lines.push(chalk.gray(`          ❯ ${repair.repro.command}`));
      lines.push(chalk.gray(`          exit ${repair.repro.before.exitCode} → ${repair.repro.after.exitCode}`));
      if (repair.rolledBack) lines.push(chalk.gray("          change reverted"));
    }
  } else {
    lines.push(`  ${pad("verify-repair")} ${seconds(report.phases.repairMs).padStart(6)}   ${chalk.gray("nothing to repair")}`);
  }

  lines.push(`  ${pad("re-scan")} ${seconds(report.phases.scanAfterMs).padStart(6)}   ${report.remaining.length} finding(s) remaining`);
  lines.push("");

  const headline = report.green
    ? `${chalk.bold.green("⏱  time to green:")} ${chalk.bold.green(seconds(report.timeToGreenMs))}`
    : `${chalk.bold.yellow("⏱  time to green:")} ${chalk.bold.yellow("not reached")} ${chalk.gray(`(${seconds(report.timeToGreenMs)} elapsed)`)}`;
  lines.push(headline);

  if (report.green) {
    lines.push(chalk.gray(`   ${report.install.offline ? "0 network calls (install was offline)" : `${report.install.networkCalls} network call(s) — install only`} · repair loop: ${report.repairNetworkCalls} network call(s)`));
  } else {
    for (const finding of report.remaining) {
      lines.push(`   ${chalk.yellow("→")} ${finding.title} ${chalk.gray(`(${finding.severity})`)}`);
      if (finding.repro) lines.push(chalk.gray(`      repro: ${finding.repro.command}`));
    }
    const appCheck = report.repair?.projectRepro?.after;
    if (appCheck && appCheck.exitCode !== 0) {
      lines.push(chalk.gray(`   the project's own check still exits ${appCheck.exitCode} (stdout sha256:${appCheck.stdoutHash.slice(0, 12)})`));
    }
  }

  const receipt = report.repair?.receipt;
  if (receipt) {
    lines.push("");
    lines.push(chalk.gray(`receipt ${receipt.id} · findings ${receipt.summary.findings} · applied ${receipt.summary.repairsApplied} · verified ${receipt.summary.repairsVerified} · escalated ${receipt.summary.repairsEscalated}`));
    lines.push(chalk.gray(`  env values printed: ${receipt.guarantees.secrets.envValuesPrinted} · telemetry: ${receipt.guarantees.telemetry} · repair-loop network calls: ${receipt.networkCalls}`));
    if (report.receiptPath) lines.push(chalk.gray(`  written to ${report.receiptPath}`));
  }
  return lines.join("\n");
}
