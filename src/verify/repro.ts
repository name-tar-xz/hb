import { spawn } from "node:child_process";
import path from "node:path";
import { ReproRun } from "../types.js";
import { sha256 } from "../util/hash.js";

export interface ReproOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  expectExitCode?: number;
  /** Secret values that must never appear in captured output. */
  secrets?: string[];
  env?: Record<string, string>;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const CLOCK_TIME = /\b\d{2}:\d{2}:\d{2}\b/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g;
const HEX_ADDRESS = /\b0x[0-9a-fA-F]{4,}\b/g;
const PID = /\bpid[=: ]\s?\d+\b/gi;
const PORT = /localhost:\d{4,5}/g;

/**
 * Normalizes captured output so identical failures produce identical fingerprints
 * — across machines, paths, and runs. This is what makes verification reproducible
 * and what lets us distinguish "the failure moved" from "the failure is the same".
 */
export function normalizeOutput(raw: string, options: { cwd: string; secrets?: string[] }): { text: string; redactions: number } {
  let text = raw.replace(ANSI, "");
  let redactions = 0;

  for (const secret of options.secrets ?? []) {
    if (!secret || secret.length < 4) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "g");
    const matches = text.match(pattern);
    if (matches?.length) {
      redactions += matches.length;
      text = text.replace(pattern, "«redacted»");
    }
  }

  text = text
    .replaceAll(options.cwd, "<root>")
    .replaceAll(options.cwd.replaceAll("\\", "/"), "<root>")
    .replace(ISO_TIMESTAMP, "<ts>")
    .replace(CLOCK_TIME, "<time>")
    .replace(DURATION, "<duration>")
    .replace(HEX_ADDRESS, "<addr>")
    .replace(PID, "pid=<pid>")
    .replace(PORT, "localhost:<port>")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, redactions };
}

/**
 * Replaces known secret values with a marker. Used both for captured process output
 * and for anything that ends up inside a receipt, because a receipt is meant to be
 * attached to a PR or a ticket.
 */
export function redactSecrets(text: string, secrets: string[]): { text: string; count: number } {
  let output = text;
  let count = 0;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "g");
    const matches = output.match(pattern);
    if (matches?.length) {
      count += matches.length;
      output = output.replace(pattern, "«redacted»");
    }
  }
  return { text: output, count };
}

/** Last few meaningful lines — this is what a human should read first. */
export function reproduceTail(text: string, lines = 6): string {
  return text.split("\n").filter(line => line.trim().length > 0).slice(-lines).join("\n");
}

const NOISE = /^(?:[\s}{\[\]]*|\s*(?:code|errno|syscall|path|stack):.*|\s*at .*|Node\.js v.*|\s*\^+\s*)$/;
const INFORMATIVE = /(?:^|\s)(?:error|fail|fatal|cannot find|enoent|econnrefused|exception|refus|denied|missing|not set|invalid|unable|timed? ?out|expected|assert)/i;

/**
 * Picks the lines that actually explain a failure, instead of handing a human a
 * stack trace. This is what shows up in reports and escalation reasons.
 */
export function summarizeFailure(text: string, fallbackLines = 3): string {
  const lines = text.split("\n").map(line => line.trimEnd());
  const candidates = lines.filter(line => line.trim().length > 0 && !NOISE.test(line));
  const informative = candidates.filter(line => INFORMATIVE.test(line));
  const chosen: string[] = [];
  const add = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || chosen.includes(trimmed)) return;
    chosen.push(trimmed);
  };
  if (informative.length) {
    for (const line of informative.slice(0, 2)) add(line);
  } else {
    for (const line of candidates.slice(-fallbackLines)) add(line);
  }
  return chosen.join("\n");
}

/**
 * Runs the project's reproduction command and records exit code, duration, a
 * stable fingerprint of the normalized output, and how many secrets were redacted.
 * Env Doctor's own environment is inherited but the command never touches the network
 * unless the project's own repo script does.
 */
export async function runRepro(options: ReproOptions): Promise<ReproRun> {
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const started = Date.now();

  return new Promise<ReproRun>(resolve => {
    let child;
    try {
      child = spawn(options.command, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: process.platform === "win32",
        env: { ...process.env, ...(options.env ?? {}), CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : "could not start the reproduction command";
      resolve({
        command: options.command, args, cwd: options.cwd, exitCode: null, timedOut: false,
        durationMs: Date.now() - started, fingerprint: sha256(text), preview: text, signature: summarizeFailure(text), redactions: 0,
      });
      return;
    }

    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const collect = (chunk: Buffer) => {
      if (output.length < 200_000) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("error", error => {
      clearTimeout(timeout);
      const text = error.message;
      resolve({
        command: options.command, args, cwd: options.cwd, exitCode: null, timedOut: false,
        durationMs: Date.now() - started, fingerprint: sha256(text), preview: text, signature: summarizeFailure(text), redactions: 0,
      });
    });

    child.on("close", code => {
      clearTimeout(timeout);
      const { text, redactions } = normalizeOutput(output, { cwd: options.cwd, secrets: options.secrets });
      const passed = code === options.expectExitCode && !timedOut;
      resolve({
        command: options.command,
        args,
        cwd: options.cwd,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        fingerprint: sha256(text),
        preview: reproduceTail(text, passed ? 3 : 8),
        signature: passed ? reproduceTail(text, 1) : summarizeFailure(text),
        redactions,
      });
    });
  });
}

/** Interprets a repro run against the expected exit code. */
export function reproPassed(run: ReproRun, expectExitCode = 0): boolean {
  return !run.timedOut && run.exitCode === expectExitCode;
}

export function describeOutcome(run: ReproRun, expectExitCode = 0): "verified-green" | "failing" | "timed-out" | "not-run" {
  if (run.timedOut) return "timed-out";
  return reproPassed(run, expectExitCode) ? "verified-green" : "failing";
}

/** A reproduction command discovered from the project's own scripts, or the policy. */
export const VERIFY_COMMAND_CANDIDATES = ["preflight", "verify", "smoke", "check:env", "doctor"] as const;

/** Resolves `npm run <script>` for the first matching script in package.json. */
export function detectVerifyCommand(packageJson: { scripts?: Record<string, string> } | undefined): { command: string; args: string[] } | undefined {
  const scripts = packageJson?.scripts ?? {};
  for (const candidate of VERIFY_COMMAND_CANDIDATES) {
    if (scripts[candidate]) return { command: "npm", args: ["run", "--silent", candidate] };
  }
  return undefined;
}

export function resolveTargetArguments(targetDir: string, command: string): { command: string; args: string[]; cwd: string } {
  return { command, args: [], cwd: path.resolve(targetDir) };
}

/** True when the second failure is meaningfully different from the first (progress). */
export function failureChanged(before: ReproRun, after: ReproRun): boolean {
  return before.fingerprint !== after.fingerprint || before.exitCode !== after.exitCode;
}
