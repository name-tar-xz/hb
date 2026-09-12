import { promises as fs } from "node:fs";
import path from "node:path";
import { Diagnosis, Receipt, RepairRecord, ReproRun } from "../types.js";
import { canonicalize, shortHash } from "../util/hash.js";
import { isTemplateValue } from "../util/placeholder.js";
import { containsSecret, evidence, redactSecrets } from "./repro.js";

export const TOOL_NAME = "env-doctor";
export const TOOL_VERSION = "1.1.0";

export interface ReceiptInput {
  targetDir: string;
  findingsBefore: Diagnosis[];
  findingsAfter: Diagnosis[];
  repairs: RepairRecord[];
  projectRepro?: { command: string; before: ReproRun; after?: ReproRun } | null;
  fileHashesBefore: Record<string, string>;
  fileHashesAfter: Record<string, string>;
  reproCommands: string[];
  reproCommandsRun: number;
  /** Env var values that must not appear anywhere in the artifact. */
  secretValues: string[];
  redactedBeforePrinting: number;
  redactedFromOutput: number;
  /** Descriptions of network calls Env Doctor itself made during the run. */
  networkCalls: string[];
  /** Escalations raised by the pipeline (placeholder values, unresolvable findings, guards). */
  escalation: Array<{ findingId: string; title: string; reason: string; reproCommand?: string }>;
}

/**
 * The receipt.
 *
 * It answers five questions and refuses to guess at any of them: how many findings
 * were active, how many repairs were applied, how many were verified by an exit-code
 * flip, which reproduction commands ran, and how many network calls were made.
 *
 * Reproduction output is represented by a hash of stdout and stderr — the raw content
 * is never written here. Timings and wall-clock fields are excluded from the receipt
 * id so the same input and outcome always produce the same id.
 */
export function buildReceipt(input: ReceiptInput): Receipt {
  // Repair messages come from the fixers and can quote an injected value; scrub them
  // before anything is serialized.
  let scrubbed = 0;
  const scrub = (text: string): string => {
    const result = redactSecrets(text, input.secretValues);
    scrubbed += result.count;
    return result.text;
  };

  const repairs: RepairRecord[] = input.repairs.map(repair => ({
    ...repair,
    message: scrub(repair.message),
    warnings: repair.warnings.map(scrub),
  }));
  const escalation = [
    ...input.escalation.map(entry => ({
      findingId: entry.findingId,
      title: entry.title,
      reason: scrub(entry.reason),
      ...(entry.reproCommand ? { reproCommand: entry.reproCommand } : {}),
    })),
    ...buildEscalations(input, repairs),
  ];
  const beforeIds = input.findingsBefore.map(item => item.id).sort();
  const afterIds = input.findingsAfter.map(item => item.id).sort();
  const resolved = beforeIds.filter(id => !afterIds.includes(id));
  const verifiedCount = repairs.filter(repair => repair.status === "verified").length;
  const escalatedCount = repairs.filter(repair => repair.status === "escalated").length;
  const projectGreen = input.projectRepro?.after ? input.projectRepro.after.exitCode === 0 : true;

  const verdict: Receipt["verdict"] = verifiedCount > 0
    ? escalatedCount === 0 && projectGreen
      ? "verified-green"
      : "partially-verified"
    : escalatedCount > 0
      ? "escalated"
      : "unchanged";

  const receipt: Receipt = {
    schema: "env-doctor/receipt@2",
    id: "",
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    target: path.basename(path.resolve(input.targetDir)) || input.targetDir,
    generatedAt: new Date().toISOString(),
    findings: { count: beforeIds.length, before: beforeIds, after: afterIds, resolved, remaining: afterIds },
    repairs,
    projectRepro: input.projectRepro
      ? {
          command: input.projectRepro.command,
          before: evidence(input.projectRepro.before),
          after: input.projectRepro.after ? evidence(input.projectRepro.after) : evidence(input.projectRepro.before),
          green: projectGreen,
        }
      : null,
    summary: {
      findings: beforeIds.length,
      repairsApplied: repairs.filter(repair => !repair.rolledBack).length,
      repairsVerified: verifiedCount,
      repairsEscalated: escalatedCount,
      reproCommandsRun: input.reproCommandsRun,
      reproCommands: [...input.reproCommands],
    },
    networkCalls: input.networkCalls.length,
    guarantees: {
      networkCalls: input.networkCalls.length,
      telemetry: "none",
      offline: input.networkCalls.length === 0,
      secrets: {
        envValuesPrinted: 0,
        redactedBeforePrinting: input.redactedBeforePrinting,
        redactedFromOutput: input.redactedFromOutput + scrubbed,
        valuesHashed: true,
        confirmed: false,
      },
    },
    escalation,
    verdict,
  };

  const identity = {
    target: receipt.target,
    findings: { before: beforeIds, after: afterIds },
    repairs: repairs.map(repair => ({
      id: repair.findingId,
      status: repair.status,
      rolledBack: repair.rolledBack,
      command: repair.repro.command,
      before: { exitCode: repair.repro.before.exitCode, stdout: repair.repro.before.stdoutHash, stderr: repair.repro.before.stderrHash },
      after: { exitCode: repair.repro.after.exitCode, stdout: repair.repro.after.stdoutHash, stderr: repair.repro.after.stderrHash },
    })),
    projectRepro: receipt.projectRepro
      ? { command: receipt.projectRepro.command, before: receipt.projectRepro.before.exitCode, after: receipt.projectRepro.after.exitCode, green: receipt.projectRepro.green }
      : null,
    verdict: receipt.verdict,
  };
  receipt.id = `sha256:${shortHash(canonicalize(identity)).slice(7)}`;

  // Measurements, not promises: scan the serialized artifact for env values.
  const serialized = JSON.stringify(receipt);
  const leaked = containsSecret(serialized, input.secretValues);
  receipt.guarantees.secrets.envValuesPrinted = leaked.length;
  receipt.guarantees.secrets.confirmed = leaked.length === 0;
  return receipt;
}

function buildEscalations(input: ReceiptInput, repairs: RepairRecord[]): Receipt["escalation"] {
  const entries: Receipt["escalation"] = [];
  for (const repair of repairs.filter(item => item.status === "escalated")) {
    entries.push({
      findingId: repair.findingId,
      title: repair.title,
      reproCommand: repair.repro.command,
      reason: [
        `Reproduction did not flip: exit ${repair.repro.before.exitCode} → ${repair.repro.after.exitCode}`,
        repair.repro.failureMoved ? "(the failure moved but did not clear)" : "(the failure was identical)",
        `— change reverted. stdout sha256:${repair.repro.after.stdoutHash.slice(0, 12)}, stderr sha256:${repair.repro.after.stderrHash.slice(0, 12)}.`,
        `Run \`${repair.repro.command}\` to see it.`,
      ].join(" "),
    });
  }
  return entries;
}

export async function writeReceipt(receipt: Receipt, filePath: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return filePath;
}

export async function readReceipt(filePath: string): Promise<Receipt | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Receipt;
    return parsed.schema === "env-doctor/receipt@2" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One-line claim for the CLI footer. */
export function receiptHeadline(receipt: Receipt): string {
  const { summary, verdict } = receipt;
  return `${verdict} · ${summary.findings} finding${summary.findings === 1 ? "" : "s"} · ${summary.repairsApplied} applied · ${summary.repairsVerified} verified · ${summary.repairsEscalated} escalated · ${summary.reproCommandsRun} repro run${summary.reproCommandsRun === 1 ? "" : "s"} · ${receipt.networkCalls} network call${receipt.networkCalls === 1 ? "" : "s"}`;
}

/**
 * Values that must never appear in output or a receipt: everything assigned in a local
 * env file, including the template values a fixer might copy out of `.env.example`.
 * Short values are skipped — they would redact unrelated text.
 */
export async function collectSecretValues(targetDir: string): Promise<string[]> {
  const values = new Set<string>();
  for (const file of [".env", ".env.local", ".env.development", ".env.example"]) {
    try {
      const source = await fs.readFile(path.join(targetDir, file), "utf8");
      for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
        if (!match) continue;
        const value = match[1].trim().replace(/^["']|["']$/g, "");
        // Templates are not credentials: they stay readable in messages and are not
        // counted as leaked values.
        if (value.length >= 6 && !isTemplateValue(value)) values.add(value);
      }
    } catch {
      /* no such file */
    }
  }
  return [...values];
}
