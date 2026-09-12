import path from "node:path";
import { markBackups, revertTo } from "../fixers/backup.js";
import { filesTouchedBy, fixDiagnosis } from "../fixers/index.js";
import { Transaction } from "../fixers/transaction.js";
import { applyPolicy } from "../policy.js";
import { scanAll } from "../scanners/index.js";
import { Diagnosis, Policy, Receipt, RepairRecord, ReproEvidence, ReproRun, ReproSpec, ScanResult } from "../types.js";
import { hashFile, hashTree, sha256 } from "../util/hash.js";
import { networkCallCount, networkCalls as networkCallList, resetNetworkLedger } from "../util/network.js";
import { evidence, failureMoved, flippedToGreen, redactSecrets, runReproSpec } from "../verify/repro.js";
import { policyRepro, projectScriptRepro } from "../verify/repro-for.js";
import { buildReceipt, collectSecretValues, receiptHeadline, writeReceipt } from "../verify/receipt.js";

export type ReproMode = "finding" | "project";

/** How the project was bootstrapped before the scan (owned by the `onboard` command). */
export interface BootstrapInfo {
  kind: "npm ci" | "npm install" | "skipped";
  command?: string;
  exitCode: number | null;
  durationMs: number;
  /** True when the install ran without any network access (locked cache / no dependencies). */
  offline: boolean;
  networkCalls: number;
  note?: string;
}

export interface PhaseTimings {
  scanBeforeMs: number;
  repairMs: number;
  scanAfterMs: number;
}

export interface VerifiedRepairOptions {
  targetDir: string;
  policy: Policy;
  /** "env" keeps the run offline and secret-safe; "all" also allows package installers. */
  repairClass: "env" | "all";
  /** "finding" uses each Diagnosis's own repro; "project" uses the repo's preflight for everything. */
  reproMode?: ReproMode;
  dryRun?: boolean;
  writeReceipt?: boolean;
  receiptPath?: string;
  log?: (line: string) => void;
  /** Recorded in the receipt when the loop is run from the `onboard` command. */
  bootstrap?: BootstrapInfo | null;
}

export interface VerifiedRepairOutcome {
  reproMode: ReproMode;
  projectRepro?: { spec: ReproSpec; before: ReproRun; after?: ReproRun } | null;
  scanBefore: ScanResult;
  scanAfter: ScanResult;
  repairs: RepairRecord[];
  receipt?: Receipt;
  receiptPath?: string;
  escalations: Array<{ findingId: string; title: string; reason: string; reproCommand?: string }>;
  summary: string;
  verified: boolean;
  /** Measured: env var values that were about to be printed and got redacted first. */
  redactedBeforePrinting: number;
  /** Wall-clock cost of each phase, measured around the work. */
  phases: PhaseTimings;
}

/**
 * Verified repair.
 *
 * For every finding: run its reproduction, apply the fix with the existing fixers,
 * run the *same* command again, and keep the change **only** if the exit code flipped
 * from non-zero to zero. Anything else is marked escalated, the change is taken back
 * out of the backup store, and the receipt records the exit codes and output hashes.
 *
 * Raw reproduction output is never stored: the evidence is the exit code plus a hash
 * of stdout and stderr.
 */
export async function runVerifiedRepair(options: VerifiedRepairOptions): Promise<VerifiedRepairOutcome> {
  const targetDir = path.resolve(options.targetDir);
  const policy = options.policy;
  const reproMode: ReproMode = options.reproMode ?? policy.verify.repro ?? "finding";
  const timeoutMs = policy.verify.timeoutMs;
  const secrets = await collectSecretValues(targetDir);
  resetNetworkLedger();

  let redactedBeforePrinting = 0;
  const rawLog = options.log ?? (() => {});
  /** Nothing reaches the terminal without passing the redactor first. */
  const emit = (line: string) => {
    const { text, count } = redactSecrets(line, secrets);
    redactedBeforePrinting += count;
    rawLog(text);
  };

  const scanBeforeStarted = Date.now();
  const scanBefore = await scanAll(targetDir);
  const scanBeforeMs = Date.now() - scanBeforeStarted;
  const beforePolicy = applyPolicy(scanBefore.diagnoses, policy);
  const findingsBefore = beforePolicy.active;
  const fileHashesBefore = await hashTree(targetDir);

  const projectSpec = (await projectScriptRepro(targetDir)) ?? (policy.verify.command ? policyRepro(policy.verify.command) : undefined);
  const reproCommands = new Set<string>();
  let reproCommandsRun = 0;
  let redactedFromOutput = 0;

  const run = async (spec: ReproSpec): Promise<ReproRun> => {
    reproCommands.add(spec.command);
    reproCommandsRun++;
    const result = await runReproSpec(spec, targetDir, { timeoutMs, secrets });
    redactedFromOutput += result.redactions;
    return result;
  };

  // Project-level baseline: the app's own check, run once before anything is touched.
  let projectBefore: ReproRun | undefined;
  if (projectSpec) {
    projectBefore = await run(projectSpec);
    emit(`▶ project reproduction: ${projectSpec.command} → exit ${projectBefore.exitCode ?? "null"}`);
  }

  const queue = findingsBefore.filter(
    diagnosis => diagnosis.autoFixable && (options.repairClass === "all" || diagnosis.category === "env"),
  );

  if (options.dryRun) {
    return {
      reproMode,
      projectRepro: projectSpec && projectBefore ? { spec: projectSpec, before: projectBefore } : null,
      scanBefore,
      scanAfter: scanBefore,
      repairs: [],
      escalations: queue.map(finding => ({
        findingId: finding.id,
        title: finding.title,
        reason: "dry run — nothing was changed",
        reproCommand: finding.repro?.command,
      })),
      summary: "Dry run — nothing was changed.",
      verified: false,
      redactedBeforePrinting,
      phases: { scanBeforeMs, repairMs: 0, scanAfterMs: 0 },
    };
  }

  const repairStarted = Date.now();
  const session = new Transaction(targetDir, `verified repair (${reproMode} reproduction)`);
  const repairs: RepairRecord[] = [];
  const escalations: VerifiedRepairOutcome["escalations"] = [];
  let kept = 0;

  for (const finding of queue) {
    const spec = reproMode === "project" ? projectSpec ?? finding.repro : finding.repro ?? projectSpec;
    if (!spec) {
      escalations.push({ findingId: finding.id, title: finding.title, reason: "No reproduction command is available for this finding, so no change was made." });
      continue;
    }

    emit(`▶ ${finding.title}`);
    const before = await run(spec);
    if (before.exitCode === 0) {
      // The failure did not reproduce, so there is nothing to prove: never change files blind.
      escalations.push({
        findingId: finding.id,
        title: finding.title,
        reason: `Not reproduced: \`${spec.command}\` already exits 0, so this finding could not be confirmed. No change was made.`,
        reproCommand: spec.command,
      });
      emit(`  ⏭ not reproducible (exit 0) — no change made`);
      continue;
    }
    if (before.exitCode !== spec.expectedFailingExitCode) {
      emit(`  ℹ expected failure exit ${spec.expectedFailingExitCode}, observed ${before.exitCode ?? "null"} — still treated as red`);
    }

    // Everything the fixer writes is journaled by backup.ts, so a rejected repair can
    // be undone without touching repairs that verification already approved.
    const mark = markBackups();
    await session.snapshotAll(filesTouchedBy(finding));
    const hashBefore = await hashOf(targetDir, filesTouchedBy(finding));

    const result = await fixDiagnosis(finding, targetDir);
    if (!result.success) {
      escalations.push({ findingId: finding.id, title: finding.title, reason: `Repair failed: ${result.message}`, reproCommand: spec.command });
      emit(`  ✗ ${result.message}`);
      continue;
    }
    if (result.changed === false) {
      emit(`  ⏭ ${result.message}`);
      continue;
    }

    const after = await run(spec);
    const flipped = flippedToGreen(before, after);
    const moved = failureMoved(before, after);
    const hashAfter = await hashOf(targetDir, filesTouchedBy(finding));
    const warnings = (result.placeholders ?? []).map(item => `value for ${item.key} is a template placeholder`);

    if (flipped) {
      kept++;
      repairs.push(record(finding, spec, filesTouchedBy(finding), hashBefore, hashAfter, "verified", false, warnings, result.message, before, after, moved));
      emit(`  ✅ verified: exit ${before.exitCode} → ${after.exitCode} · stdout ${after.stdoutHash.slice(0, 12)}`);
      for (const line of result.message.split("\n")) emit(`  ${line}`);
      for (const placeholder of result.placeholders ?? []) {
        escalations.push({
          findingId: finding.id,
          title: finding.title,
          reason: `The reproduction is green, but ${placeholder.key} now holds a template value. Replace it before this reaches a real environment.`,
          reproCommand: spec.command,
        });
      }
      continue;
    }

    // Not proven → take the change back.
    const rollback = await revertTo(targetDir, mark);
    repairs.push(record(finding, spec, filesTouchedBy(finding), hashBefore, hashBefore, "escalated", true, warnings, result.message, before, after, moved));
    escalations.push({
      findingId: finding.id,
      title: finding.title,
      reason: [
        `The reproduction did not flip: exit ${before.exitCode} → ${after.exitCode}${after.timedOut ? " (timed out)" : ""}.`,
        moved ? "The failure moved but did not clear." : "The failure was identical.",
        `Change reverted (${rollback.restored.length} file${rollback.restored.length === 1 ? "" : "s"}).`,
        `stdout sha256:${after.stdoutHash.slice(0, 12)} · stderr sha256:${after.stderrHash.slice(0, 12)}.`,
        `Run \`${spec.command}\` to see the failure.`,
      ].join(" "),
      reproCommand: spec.command,
    });
    emit(`  ↩ escalated: exit ${before.exitCode} → ${after.exitCode} — change reverted`);
  }

  // Project-level guard: "does the app work now?" — asked again after the repairs.
  let projectAfter: ReproRun | undefined;
  let projectGreen = true;
  if (projectSpec) {
    projectAfter = await run(projectSpec);
    projectGreen = projectAfter.exitCode === 0;
    if (!projectGreen && kept > 0) {
      escalations.push({
        findingId: "project-reproduction",
        title: `The project still fails: ${projectSpec.command}`,
        reason: `Every kept repair was verified against its own reproduction, but the project's own check still exits ${projectAfter.exitCode ?? "null"} (stdout sha256:${projectAfter.stdoutHash.slice(0, 12)}). The remaining failure is not one of the environment problems that were repaired.`,
        reproCommand: projectSpec.command,
      });
    }
    emit(`▶ project reproduction after repairs: exit ${projectAfter.exitCode ?? "null"}`);
  }

  const repairMs = Date.now() - repairStarted;
  const scanAfterStarted = Date.now();
  const scanAfter = await scanAll(targetDir);
  const scanAfterMs = Date.now() - scanAfterStarted;
  const afterPolicy = applyPolicy(scanAfter.diagnoses, policy);
  const fileHashesAfter = await hashTree(targetDir);

  for (const finding of afterPolicy.active.filter(item => !item.autoFixable)) {
    if (escalations.some(entry => entry.findingId === finding.id)) continue;
    escalations.push({
      findingId: finding.id,
      title: finding.title,
      reason:
        finding.details?.kind === "placeholder"
          ? `${finding.details.key ?? "This variable"} still holds a template value; a real credential is required.`
          : finding.category === "runtime"
            ? "Runtime versions disagree. Align .nvmrc / engines / CI, then re-run the reproduction."
            : "No safe automatic repair exists for this finding; it needs a human decision.",
      reproCommand: finding.repro?.command,
    });
  }

  const networkCalls = networkCallCount();
  const networkCallDescriptions = networkCallList();
  const receipt = buildReceipt({
    targetDir,
    findingsBefore,
    findingsAfter: afterPolicy.active,
    repairs,
    projectRepro: projectSpec && projectBefore ? { command: projectSpec.command, before: projectBefore, after: projectAfter } : null,
    fileHashesBefore,
    fileHashesAfter,
    reproCommands: [...reproCommands],
    reproCommandsRun,
    secretValues: secrets,
    redactedBeforePrinting,
    redactedFromOutput,
    networkCalls: networkCallDescriptions,
    escalation: escalations,
    bootstrap: options.bootstrap
      ? {
          kind: options.bootstrap.kind,
          command: options.bootstrap.command ?? options.bootstrap.kind,
          exitCode: options.bootstrap.exitCode,
          durationMs: options.bootstrap.durationMs,
          offline: options.bootstrap.offline,
          networkCalls: options.bootstrap.networkCalls,
          note: options.bootstrap.note,
        }
      : null,
  });

  let receiptPath: string | undefined;
  if (options.writeReceipt !== false) {
    const destination = options.receiptPath ?? policy.receipt.out ?? path.join(targetDir, "envdoctor-receipt.json");
    receiptPath = await writeReceipt(receipt, path.resolve(destination));
    emit(`📄 receipt: ${receiptPath}`);
  }

  if (repairs.some(repair => !repair.rolledBack)) {
    await session.commit();
    emit(`↩ undo with: env-doctor revert ${targetDir}`);
  } else {
    await session.discard();
  }

  if (receipt.guarantees.secrets.envValuesPrinted > 0) {
    emit(`⚠ ${receipt.guarantees.secrets.envValuesPrinted} environment value(s) reached the receipt — this is a bug, please report it.`);
  }

  return {
    reproMode,
    projectRepro: projectSpec && projectBefore ? { spec: projectSpec, before: projectBefore, after: projectAfter } : null,
    scanBefore,
    scanAfter,
    repairs,
    receipt,
    receiptPath,
    escalations,
    summary: receiptHeadline(receipt),
    verified: receipt.verdict === "verified-green",
    redactedBeforePrinting,
    phases: { scanBeforeMs, repairMs, scanAfterMs },
  };
}

function record(
  finding: Diagnosis,
  spec: ReproSpec,
  files: string[],
  beforeHash: string,
  afterHash: string,
  status: RepairRecord["status"],
  rolledBack: boolean,
  warnings: string[],
  message: string,
  before: ReproRun,
  after: ReproRun,
  moved: boolean,
): RepairRecord {
  return {
    findingId: finding.id,
    title: finding.title,
    files,
    fixer: finding.fixDescription ?? finding.details?.kind ?? "auto",
    status,
    repro: {
      command: spec.command,
      expectedFailingExitCode: spec.expectedFailingExitCode,
      before: evidence(before),
      after: evidence(after),
      flipped: status === "verified",
      failureMoved: moved,
    },
    beforeHash,
    afterHash,
    rolledBack,
    warnings,
    message,
  };
}

async function hashOf(targetDir: string, files: string[]): Promise<string> {
  const payload = await Promise.all(files.map(async file => `${file}:${(await hashFile(path.join(targetDir, file))) ?? "absent"}`));
  return sha256(payload.join("|")).slice(0, 16);
}

export type { ReproEvidence };
