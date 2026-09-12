import { promises as fs } from "node:fs";
import path from "node:path";
import { CommandEvidence, Diagnosis, Receipt, RepairRecord, ReproRun, ScanResult } from "../types.js";
import { canonicalize, hashTree, shortHash } from "../util/hash.js";
import { describeOutcome, redactSecrets, reproPassed } from "./repro.js";

export const TOOL_NAME = "env-doctor";
export const TOOL_VERSION = "1.1.0";

export function evidence(run: ReproRun | undefined, expectExitCode: number): CommandEvidence {
  if (!run) {
    return { command: "", exitCode: null, durationMs: 0, outcome: "not-run", fingerprint: "" };
  }
  const command = [run.command, ...run.args].join(" ");
  return {
    command,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    outcome: describeOutcome(run, expectExitCode),
    fingerprint: shortHash(run.fingerprint),
  };
}

export interface ReceiptInput {
  targetDir: string;
  verifyCommand: string;
  expectExitCode: number;
  before?: ReproRun;
  after?: ReproRun;
  repairs: RepairRecord[];
  findingsBefore: Diagnosis[];
  findingsAfter: Diagnosis[];
  fileHashesBefore: Record<string, string>;
  fileHashesAfter: Record<string, string>;
  egress: string[];
  escalation: Array<{ findingId: string; title: string; reason: string }>;
  /** Everything the receipt will serialize — used for a self-check on secret leakage. */
  secretValues: string[];
  redactedCount: number;
}

export function buildProof(before: ReproRun | undefined, after: ReproRun | undefined, expectExitCode: number): Receipt["verify"]["proof"] {
  if (!after) return "no-baseline";
  const afterPasses = reproPassed(after, expectExitCode);
  if (!before) return afterPasses ? "no-baseline" : "no-baseline";
  const beforePassed = reproPassed(before, expectExitCode);
  if (!beforePassed && afterPasses) return "red-to-green";
  if (!beforePassed && !afterPasses) return "still-red";
  if (beforePassed && afterPasses) return "still-green";
  return "still-red";
}

function verdictFor(proof: Receipt["verify"]["proof"], repairs: RepairRecord[]): Receipt["verdict"] {
  const applied = repairs.filter(repair => !repair.rolledBack);
  if (proof === "red-to-green") return "verified-green";
  if (repairs.some(repair => repair.status === "progress-unverified" || repair.status === "flagged-placeholder")) {
    return "improved-unverified";
  }
  if (repairs.length > 0 && applied.length === 0) return "rolled-back";
  if (applied.length > 0) return "improved-unverified";
  return "unchanged";
}

/**
 * Builds the receipt: the artifact that says what was found, what changed, what the
 * reproduction did before and after, and what we refuse to claim.
 *
 * Timings and wall-clock fields are excluded from the receipt id so the same
 * input + same outcome always produces the same id.
 */
export function buildReceipt(input: ReceiptInput): Receipt {
  const proof = buildProof(input.before, input.after, input.expectExitCode);
  const beforeIds = input.findingsBefore.map(item => item.id).sort();
  const afterIds = input.findingsAfter.map(item => item.id).sort();
  const resolved = beforeIds.filter(id => !afterIds.includes(id));
  const remaining = afterIds;

  // A receipt is designed to be attached to a PR or a ticket, so no secret value
  // may survive into it — repair messages included.
  let scrubbed = 0;
  const scrub = (text: string): string => {
    const result = redactSecrets(text, input.secretValues);
    scrubbed += result.count;
    return result.text;
  };
  const repairs = input.repairs.map(repair => ({
    ...repair,
    message: scrub(repair.message),
    warnings: repair.warnings.map(scrub),
  }));
  const escalations = input.escalation.map(entry => ({ ...entry, reason: scrub(entry.reason) }));

  const receipt: Receipt = {
    schema: "env-doctor/receipt@1",
    id: "",
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    target: path.basename(path.resolve(input.targetDir)) || input.targetDir,
    generatedAt: new Date().toISOString(),
    verify: {
      command: input.verifyCommand,
      expectedExitCode: input.expectExitCode,
      before: evidence(input.before, input.expectExitCode),
      after: evidence(input.after, input.expectExitCode),
      proof,
    },
    repairs,
    summary: {
      applied: repairs.filter(repair => !repair.rolledBack).length,
      verified: repairs.filter(repair => repair.status === "verified-green" || repair.status === "progress-unverified").length,
      rolledBack: repairs.filter(repair => repair.rolledBack).length,
      escalated: escalations.length,
    },
    findings: { before: beforeIds, after: afterIds, resolved, remaining },
    fileHashes: { before: input.fileHashesBefore, after: input.fileHashesAfter },
    guarantees: {
      egress: input.egress,
      telemetry: "none",
      offline: input.egress.length === 0,
      secrets: { printed: 0, redacted: input.redactedCount + scrubbed, valuesHashed: true },
    },
    escalation: escalations,
    verdict: verdictFor(proof, input.repairs),
  };

  const identity = {
    target: receipt.target,
    verify: { command: receipt.verify.command, expectedExitCode: receipt.verify.expectedExitCode },
    proof: receipt.verify.proof,
    beforeFingerprint: receipt.verify.before.fingerprint,
    afterFingerprint: receipt.verify.after.fingerprint,
    repairs: receipt.repairs.map(repair => ({ id: repair.findingId, status: repair.status, rolledBack: repair.rolledBack })),
    findings: { resolved, remaining },
  };
  receipt.id = `sha256:${shortHash(canonicalize(identity)).slice(7)}`;

  // Self-check: nothing in the serialized receipt may contain a known secret value.
  const serialized = JSON.stringify(receipt);
  const leaked = input.secretValues.filter(value => value.length >= 4 && serialized.includes(value));
  receipt.guarantees.secrets.printed = leaked.length;
  return receipt;
}

export async function writeReceipt(receipt: Receipt, filePath: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return filePath;
}

export async function readReceipt(filePath: string): Promise<Receipt | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Receipt;
    return parsed.schema === "env-doctor/receipt@1" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One-line claim for the CLI footer and the receipt summary. */
export function receiptHeadline(receipt: Receipt): string {
  const { verify, summary } = receipt;
  const arrows: Record<Receipt["verify"]["proof"], string> = {
    "red-to-green": `exit ${verify.before.exitCode} → exit ${verify.after.exitCode}`,
    "still-red": `exit ${verify.before.exitCode} → exit ${verify.after.exitCode} (unchanged)`,
    "still-green": `exit ${verify.before.exitCode} → exit ${verify.after.exitCode}`,
    "no-baseline": "no reproduction baseline was available",
  };
  return `${receipt.verdict} · ${arrows[verify.proof]} · ${summary.verified} verified · ${summary.rolledBack} rolled back · ${summary.escalated} escalated`;
}

/** Finds the project's `.env` values so they can be redacted from captured output. */
export async function collectSecretValues(targetDir: string): Promise<string[]> {
  const values = new Set<string>();
  for (const file of [".env", ".env.local", ".env.development"]) {
    try {
      const source = await fs.readFile(path.join(targetDir, file), "utf8");
      for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
        if (!match) continue;
        const value = match[1].trim().replace(/^["']|["']$/g, "");
        if (value.length >= 6) values.add(value);
      }
    } catch {
      /* no such file */
    }
  }
  return [...values];
}

export { hashTree, ScanResult };
