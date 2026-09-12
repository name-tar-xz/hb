import chalk from "chalk";
import { Diagnosis, ScanResult } from "../types.js";

function paint(diagnosis: Diagnosis): string {
  const icon = diagnosis.severity === "error" ? "❌" : diagnosis.severity === "warning" ? "⚠️ " : "ℹ️ ";
  const color = diagnosis.severity === "error" ? chalk.red : diagnosis.severity === "warning" ? chalk.yellow : chalk.blue;
  const location = diagnosis.file ? ` (${diagnosis.file}${diagnosis.line ? `:${diagnosis.line}` : ""})` : "";
  return `${color(`${icon} ${diagnosis.title}`)}${location}\n   ${diagnosis.message}`;
}
export function renderReport(result: ScanResult): string {
  const unresolved = result.diagnoses.filter(d => !d.fixed);
  if (!unresolved.length) return `${chalk.bold("🩺 Env Doctor — Scan Report")}\n${"─".repeat(28)}\n${chalk.green("✅ All clear! Your environment is healthy.")}`;
  const errors = unresolved.filter(d => d.severity === "error").length;
  const warnings = unresolved.filter(d => d.severity === "warning").length;
  const fixable = unresolved.filter(d => d.autoFixable).length;
  return `${chalk.bold("🩺 Env Doctor — Scan Report")}\n${"─".repeat(28)}\n${unresolved.map(paint).join("\n\n")}\n\n${chalk.bold(`Summary: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`)}${fixable ? `\nRun with --fix to auto-resolve ${fixable} of ${unresolved.length} issues.` : ""}`;
}
