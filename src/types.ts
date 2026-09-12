export type Severity = "error" | "warning" | "info";

/**
 * How a single finding is reproduced: the command a human would run to see this
 * specific failure, and the exit code it fails with while the finding is present.
 */
export interface ReproSpec {
  command: string;
  expectedFailingExitCode: number;
  source: "generated" | "project-script" | "policy";
  /** Set when the command runs through a shell (generated one-liners do). */
  shell?: boolean;
}

export interface Diagnosis {
  id: string;
  category: "dependency" | "version" | "env" | "runtime";
  severity: Severity;
  title: string;
  message: string;
  file?: string;
  line?: number;
  autoFixable: boolean;
  fixDescription?: string;
  fixed?: boolean;
  /** Internal metadata used by fixers; never required by report consumers. */
  details?: Record<string, string>;
  /** Added by every scanner: how to reproduce this finding, and how it fails. */
  repro?: ReproSpec;
  /** Present when the finding was matched by a policy waiver. */
  waivered?: { by: string; reason?: string; expires?: string };
}

export interface ScanResult {
  diagnoses: Diagnosis[];
  scannedAt: string;
  targetDir: string;
  policy?: { source?: string; ignored: number; waivered: number; expired: number };
}

export interface FixResult {
  success: boolean;
  message: string;
  /** True when the fixer wrote to disk (as opposed to a no-op). */
  changed?: boolean;
  /** Values injected by the fixer that look like placeholders. */
  placeholders?: Array<{ key: string; value: string }>;
}

/* ------------------------------------------------------------------ *
 * Verification: reproduction, repair records, receipts
 * ------------------------------------------------------------------ */

/** Exit code plus hashes of the captured streams. Raw output is never retained. */
export interface ReproEvidence {
  exitCode: number | null;
  stdoutHash: string;
  stderrHash: string;
  /** Hash of the two streams combined and normalized; used for "same failure?" checks. */
  outputHash: string;
  timedOut: boolean;
  durationMs: number;
}

/** The outcome of executing a reproduction command. */
export interface ReproRun extends ReproEvidence {
  command: string;
  args: string[];
  cwd: string;
  expectExitCode: number;
  /**
   * Transient, in-memory only. Used for the terminal report and never written to a
   * receipt — receipts carry hashes, not output.
   */
  signature?: string;
  /** How many secret values were redacted out of the captured output. */
  redactions: number;
}

export type RepairStatus = "verified" | "escalated";

export interface RepairRecord {
  findingId: string;
  title: string;
  files: string[];
  fixer: string;
  status: RepairStatus;
  repro: {
    command: string;
    expectedFailingExitCode: number;
    before: ReproEvidence;
    after: ReproEvidence;
    /** true only when the exit code flipped from non-zero to zero. */
    flipped: boolean;
    /** true when the failure changed but did not clear — still not kept. */
    failureMoved: boolean;
  };
  /** sha256 of the file contents before and after this repair. */
  beforeHash: string;
  afterHash: string;
  /** True when the change was rolled back with the backup store. */
  rolledBack: boolean;
  warnings: string[];
  message: string;
}

export interface ReceiptSecretSafety {
  /** Measured: env var values that appear in the serialized receipt. */
  envValuesPrinted: number;
  /** Measured: env var values that were about to be printed and got redacted. */
  redactedBeforePrinting: number;
  /** Measured: env var values redacted out of captured process output. */
  redactedFromOutput: number;
  valuesHashed: boolean;
  confirmed: boolean;
}

export interface Receipt {
  schema: "env-doctor/receipt@2";
  id: string;
  tool: { name: string; version: string };
  target: string;
  generatedAt: string;
  findings: {
    count: number;
    before: string[];
    after: string[];
    resolved: string[];
    remaining: string[];
  };
  repairs: RepairRecord[];
  /** The project-level reproduction, when the repo has one (the app's own check). */
  projectRepro?: {
    command: string;
    before: ReproEvidence;
    after: ReproEvidence;
    green: boolean;
  } | null;
  summary: {
    findings: number;
    repairsApplied: number;
    repairsVerified: number;
    repairsEscalated: number;
    reproCommandsRun: number;
    reproCommands: string[];
  };
  /** Network calls made by Env Doctor itself. Must be 0 for offline repair runs. */
  networkCalls: number;
  guarantees: {
    networkCalls: number;
    telemetry: "none";
    offline: boolean;
    secrets: ReceiptSecretSafety;
  };
  escalation: Array<{ findingId: string; title: string; reason: string; reproCommand?: string }>;
  verdict: "verified-green" | "partially-verified" | "escalated" | "unchanged";
}

/* ------------------------------------------------------------------ *
 * Fingerprint: a hashable model of "this machine"
 * ------------------------------------------------------------------ */

export interface Fingerprint {
  schema: "env-doctor/fingerprint@1";
  id: string;
  target: string;
  runtime: {
    node: string;
    npm?: string;
    python?: string;
    platform: string;
    arch: string;
  };
  /** What the repo *asks* for — the contract side of the comparison. */
  declared: {
    nvmrc?: string;
    enginesNode?: string;
  };
  lockfile: Array<{ file: string; package: string; declared?: string; locked?: string; drift: boolean }>;
  env: Array<{ key: string; present: boolean; /** sha256 of the value, never the value */ valueHash?: string; placeholder?: boolean }>;
  manifests: string[];
  verify?: { command: string; lastOutcome?: string };
  receipt?: { id: string; verdict: Receipt["verdict"] } | null;
}

export type FingerprintDiff = Array<{ section: string; key: string; here?: string; there?: string }>;

/* ------------------------------------------------------------------ *
 * Policy (.envdoctor.yml)
 * ------------------------------------------------------------------ */

export interface Waiver {
  id: string;
  reason?: string;
  expires?: string;
  by?: string;
}

export interface Policy {
  /** Path the policy was loaded from, if any. */
  source?: string;
  failOn: Severity | "none";
  ignore: string[];
  waivers: Waiver[];
  verify: {
    command?: string;
    expectExitCode: number;
    timeoutMs: number;
    /** Repair classes the verified-repair loop is allowed to apply. */
    repairs: "env" | "all";
    /** Which reproduction the verified loop prefers. */
    repro: "finding" | "project";
  };
  sarif: { out?: string };
  receipt: { out?: string };
}
