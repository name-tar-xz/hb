import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyPolicy, evaluateGate } from "../policy.js";
import { Diagnosis, Policy, ScanResult } from "../types.js";
import { networkCallCount, recordNetworkCall, resetNetworkLedger } from "../util/network.js";
import { scanAll } from "../scanners/index.js";
import { BootstrapInfo, PhaseTimings, runVerifiedRepair, VerifiedRepairOutcome } from "./verified-repair.js";

export interface OnboardOptions {
  targetDir: string;
  policy: Policy;
  /** "env" keeps the repair loop offline; "all" also allows package installers during repair. */
  repairClass: "env" | "all";
  reproMode?: "finding" | "project";
  /** Skip the clean install (fully offline run). */
  install?: boolean;
  /** Override the install command, e.g. "npm install --legacy-peer-deps". */
  installCommand?: string;
  writeReceipt?: boolean;
  receiptPath?: string;
  log?: (line: string) => void;
}

export interface OnboardReport {
  target: string;
  /** The app's own check passes and no error-severity finding remains. */
  green: boolean;
  timeToGreenMs: number;
  install: BootstrapInfo;
  scanBefore: ScanResult;
  scanAfter: ScanResult;
  /** Present when the scan found something the verified loop could act on. */
  repair?: VerifiedRepairOutcome;
  remaining: Diagnosis[];
  /** Egress during the repair loop (0 for the default offline repair class). */
  repairNetworkCalls: number;
  phases: PhaseTimings & { installMs: number; totalMs: number };
  receiptPath?: string;
}

/* ------------------------------------------------------------------ *
 * Clean install
 * ------------------------------------------------------------------ */

function run(command: string, args: string[], cwd: string, timeoutMs = 300_000): Promise<{ exitCode: number | null; output: string }> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, shell: process.platform === "win32" });
    } catch (error) {
      resolve({ exitCode: null, output: error instanceof Error ? error.message : "could not start the installer" });
      return;
    }
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", chunk => { if (output.length < 40_000) output += chunk.toString("utf8"); });
    child.stderr?.on("data", chunk => { if (output.length < 40_000) output += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timeout); resolve({ exitCode: null, output: `${output}${error.message}` }); });
    child.on("close", code => { clearTimeout(timeout); resolve({ exitCode: code, output }); });
  });
}

const NPM_FLAGS = ["--no-audit", "--no-fund"];

/**
 * A clean install of the project's dependencies, the way a fresh clone would do it.
 *
 * `npm ci --offline` is attempted first: for a locked, cached or dependency-free repo
 * that succeeds without touching the network, and the report says so. Only if that
 * fails does the install go to the registry, which is recorded as a network call —
 * the accounting is measured rather than assumed, and `--no-install` skips this phase
 * entirely for a fully offline run.
 */
export async function cleanInstall(targetDir: string, options: { command?: string; timeoutMs?: number } = {}): Promise<BootstrapInfo> {
  const started = Date.now();
  const hasManifest = await fs.access(path.join(targetDir, "package.json")).then(() => true).catch(() => false);
  if (!hasManifest) {
    return { kind: "skipped", exitCode: 0, durationMs: Date.now() - started, offline: true, networkCalls: 0, note: "no package.json — nothing to install" };
  }

  if (options.command) {
    const [binary, ...args] = options.command.split(/\s+/).filter(Boolean);
    recordNetworkCall(`${options.command} (dependency installation)`);
    const result = await run(binary, args, targetDir, options.timeoutMs);
    return {
      kind: "npm install", command: options.command, exitCode: result.exitCode,
      durationMs: Date.now() - started, offline: false, networkCalls: 1,
      note: result.exitCode === 0 ? undefined : result.output.trim().split("\n").slice(-3).join(" "),
    };
  }

  const hasLockfile = await fs.access(path.join(targetDir, "package-lock.json")).then(() => true).catch(() => false);
  if (hasLockfile) {
    // Cache-only first: no registry contact when the lockfile is satisfiable offline.
    const offline = await run("npm", ["ci", ...NPM_FLAGS, "--offline"], targetDir, options.timeoutMs);
    if (offline.exitCode === 0) {
      return { kind: "npm ci", command: "npm ci --offline", exitCode: 0, durationMs: Date.now() - started, offline: true, networkCalls: 0, note: "installed from the local npm cache — no registry contact" };
    }
    recordNetworkCall("npm ci (dependency installation)");
    const online = await run("npm", ["ci", ...NPM_FLAGS, "--prefer-offline"], targetDir, options.timeoutMs);
    if (online.exitCode === 0) {
      return { kind: "npm ci", command: "npm ci", exitCode: 0, durationMs: Date.now() - started, offline: false, networkCalls: 1 };
    }
    recordNetworkCall("npm install (fallback after a failed npm ci)");
    const fallback = await run("npm", ["install", ...NPM_FLAGS], targetDir, options.timeoutMs);
    return {
      kind: "npm install", command: "npm install", exitCode: fallback.exitCode, durationMs: Date.now() - started,
      offline: false, networkCalls: 2,
      note: fallback.exitCode === 0 ? "npm ci failed (lockfile out of sync); npm install was used" : fallback.output.trim().split("\n").slice(-3).join(" "),
    };
  }

  recordNetworkCall("npm install (dependency installation)");
  const install = await run("npm", ["install", ...NPM_FLAGS], targetDir, options.timeoutMs);
  return {
    kind: "npm install", command: "npm install", exitCode: install.exitCode, durationMs: Date.now() - started,
    offline: false, networkCalls: 1,
    note: install.exitCode === 0 ? "no lockfile found; npm install was used" : install.output.trim().split("\n").slice(-3).join(" "),
  };
}

/* ------------------------------------------------------------------ *
 * Onboard: clean install → scan → verified repair → re-scan → time to green
 * ------------------------------------------------------------------ */

/**
 * The whole journey a new contributor makes, measured:
 *
 *   1. clean install, the way a fresh clone does it
 *   2. scan
 *   3. if broken, the verified repair loop (reproduce → repair → re-verify)
 *   4. re-scan
 *   5. report the elapsed time as **time to green**
 *
 * Green means the app's own check passes and no error-severity finding remains.
 * A remaining warning is reported and does not stop the clock from being honest:
 * the report always says what is left.
 */
export async function runOnboard(options: OnboardOptions): Promise<OnboardReport> {
  const targetDir = path.resolve(options.targetDir);
  const log = options.log ?? (() => {});
  const started = Date.now();
  resetNetworkLedger();

  const install = options.install === false
    ? ({ kind: "skipped", exitCode: 0, durationMs: 0, offline: true, networkCalls: 0, note: "skipped with --no-install" } as BootstrapInfo)
    : await cleanInstall(targetDir, { command: options.installCommand });
  log(`▶ clean install        ${install.command ?? install.kind} ${install.exitCode === 0 ? "✔" : `✖ exit ${install.exitCode}`} in ${install.durationMs}ms${install.offline ? " (offline)" : ""}`);

  const scanStarted = Date.now();
  const scanBefore = await scanAll(targetDir);
  const scanBeforePolicy = applyPolicy(scanBefore.diagnoses, options.policy);
  log(`▶ scan                ${scanBeforePolicy.active.length} finding(s) in ${Date.now() - scanStarted}ms`);

  const fixable = scanBeforePolicy.active.filter(
    diagnosis => diagnosis.autoFixable && (options.repairClass === "all" || diagnosis.category === "env"),
  );

  let repair: VerifiedRepairOutcome | undefined;
  if (fixable.length > 0) {
    repair = await runVerifiedRepair({
      targetDir,
      policy: options.policy,
      repairClass: options.repairClass,
      reproMode: options.reproMode,
      writeReceipt: options.writeReceipt,
      receiptPath: options.receiptPath,
      log,
      bootstrap: install,
    });
  } else {
    log(`▶ verified repair     not needed — nothing safely fixable was found`);
  }

  const rescanStarted = Date.now();
  const scanAfter = repair?.scanAfter ?? await scanAll(targetDir);
  const rescanMs = repair ? repair.phases.scanAfterMs : Date.now() - rescanStarted;
  const afterPolicy = applyPolicy(scanAfter.diagnoses, options.policy);
  const remaining = afterPolicy.active;
  log(`▶ re-scan             ${remaining.length} finding(s) in ${rescanMs}ms`);

  const gate = evaluateGate(remaining, options.policy);
  const appCheck = repair?.projectRepro?.after;
  const appGreen = appCheck ? appCheck.exitCode === 0 : true;
  // Green means both halves: the policy gate passes and the app's own check passes.
  const green = !gate.fail && appGreen;
  const timeToGreenMs = Date.now() - started;

  const phases = {
    installMs: install.durationMs,
    scanBeforeMs: repair?.phases.scanBeforeMs ?? Date.now() - scanStarted,
    repairMs: repair?.phases.repairMs ?? 0,
    scanAfterMs: rescanMs,
    totalMs: timeToGreenMs,
  };

  if (repair && options.writeReceipt !== false) {
    // The receipt is written by the loop before the timer stops; the timing block is
    // added here so the artifact carries the same numbers the report prints.
    repair.receiptPath = await annotateReceipt(repair, phases, install, green, timeToGreenMs);
  }

  return {
    target: targetDir,
    green,
    timeToGreenMs,
    install,
    scanBefore,
    scanAfter,
    repair,
    remaining,
    repairNetworkCalls: repair ? networkCallCount() - install.networkCalls : 0,
    phases,
    receiptPath: repair?.receiptPath,
  };
}

/**
 * Adds the bootstrap and time-to-green blocks to the receipt the loop wrote, then
 * rewrites it. The receipt id is left untouched because it identifies the *outcome*
 * (findings, repairs, exit codes); the timing blocks describe the session around it.
 */
async function annotateReceipt(
  repair: VerifiedRepairOutcome,
  phases: OnboardReport["phases"],
  install: BootstrapInfo,
  green: boolean,
  timeToGreenMs: number,
): Promise<string | undefined> {
  if (!repair.receiptPath || !repair.receipt) return repair.receiptPath;
  const { promises: fs } = await import("node:fs");
  const annotated = {
    ...repair.receipt,
    bootstrap: {
      kind: install.kind,
      command: install.command ?? install.kind,
      exitCode: install.exitCode,
      durationMs: install.durationMs,
      offline: install.offline,
      networkCalls: install.networkCalls,
      note: install.note,
    },
    timeToGreen: {
      ms: timeToGreenMs,
      green,
      phases,
    },
  };
  await fs.writeFile(repair.receiptPath, `${JSON.stringify(annotated, null, 2)}\n`);
  repair.receipt = annotated as VerifiedRepairOutcome["receipt"];
  return repair.receiptPath;
}

export type { Diagnosis, Policy };
