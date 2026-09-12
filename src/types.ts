export type Severity = "error" | "warning" | "info";

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

/** The outcome of executing a project's reproduction command. */
export interface ReproRun {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** sha256 of the normalized output. Stable across machines and paths. */
  fingerprint: string;
  /** Normalized output tail, safe to print (secrets redacted). */
  preview: string;
  /** The one or two lines that actually explain the outcome. */
  signature: string;
  /** How many secret values were redacted out of the captured output. */
  redactions: number;
}

/** An executed command, recorded as evidence on the receipt. */
export interface CommandEvidence {
  command: string;
  exitCode: number | null;
  durationMs: number;
  /** "verified-green" when it flipped to the expected exit code, else the observed state. */
  outcome: "verified-green" | "failing" | "timed-out" | "not-run";
  fingerprint: string;
}

export type RepairStatus =
  | "verified-green"
  | "progress-unverified"
  | "rolled-back-no-effect"
  | "flagged-placeholder"
  | "failed";

export interface RepairRecord {
  findingId: string;
  title: string;
  files: string[];
  fixer: string;
  status: RepairStatus;
  /** sha256 of the file contents before and after this repair. */
  beforeHash: string;
  afterHash: string;
  /** Repro observed after applying this repair. */
  repro?: { exitCode: number | null; fingerprint: string };
  rolledBack: boolean;
  warnings: string[];
  message: string;
}

export interface ReceiptSecretSafety {
  printed: number;
  redacted: number;
  valuesHashed: boolean;
}

export interface Receipt {
  schema: "env-doctor/receipt@1";
  id: string;
  tool: { name: string; version: string };
  target: string;
  generatedAt: string;
  verify: {
    command: string;
    expectedExitCode: number;
    before: CommandEvidence;
    after: CommandEvidence;
    /** The headline claim: did the reproduction flip from red to green? */
    proof: "red-to-green" | "still-red" | "no-baseline" | "still-green";
  };
  repairs: RepairRecord[];
  summary: {
    applied: number;
    verified: number;
    rolledBack: number;
    escalated: number;
  };
  findings: { before: string[]; after: string[]; resolved: string[]; remaining: string[] };
  fileHashes: { before: Record<string, string>; after: Record<string, string> };
  guarantees: {
    /** Network calls made by Env Doctor itself. Installer repairs are the only exception. */
    egress: string[];
    telemetry: "none";
    offline: boolean;
    secrets: ReceiptSecretSafety;
  };
  escalation: Array<{ findingId: string; title: string; reason: string }>;
  verdict: "verified-green" | "improved-unverified" | "rolled-back" | "unchanged";
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
  };
  sarif: { out?: string };
  receipt: { out?: string };
}
