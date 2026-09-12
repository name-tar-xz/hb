import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { Policy, Severity, Waiver } from "./types.js";

const POLICY_FILES = [".envdoctor.yml", ".envdoctor.yaml", ".envdoctor.json"];

export function defaultPolicy(): Policy {
  return {
    failOn: "error",
    ignore: [],
    waivers: [],
    verify: { expectExitCode: 0, timeoutMs: 60_000, repairs: "env" },
    sarif: {},
    receipt: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Loads `.envdoctor.yml` (or `.json`) from the target directory.
 * Unknown keys are preserved in `raw` so a policy can be used as a sandbox for
 * future rules without breaking older tool versions.
 */
export async function loadPolicy(targetDir: string, explicitPath?: string): Promise<Policy & { raw?: Record<string, unknown> }> {
  const policy = defaultPolicy();
  const candidates = explicitPath ? [explicitPath] : POLICY_FILES;
  for (const candidate of candidates) {
    let source: string;
    try {
      source = await fs.readFile(path.isAbsolute(candidate) ? candidate : path.resolve(targetDir, candidate), "utf8");
    } catch (error) {
      if (explicitPath) throw new Error(`Could not read policy file ${candidate}: ${error instanceof Error ? error.message : "unreadable"}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = candidate.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
    } catch (error) {
      throw new Error(`Could not parse ${candidate}: ${error instanceof Error ? error.message : "invalid syntax"}`);
    }
    const raw = asRecord(parsed);
    policy.source = candidate;

    const failOn = raw.failOn ?? raw["fail-on"];
    if (failOn === "none" || failOn === "error" || failOn === "warning" || failOn === "info") policy.failOn = failOn;

    const ignore = raw.ignore;
    if (ignore !== undefined) policy.ignore = asStringArray(ignore);

    if (Array.isArray(raw.waivers)) {
      policy.waivers = raw.waivers.map((entry): Waiver => {
        const record = asRecord(entry);
        return {
          id: String(record.id ?? ""),
          reason: record.reason === undefined ? undefined : String(record.reason),
          expires: record.expires === undefined ? undefined : String(record.expires),
          by: record.by === undefined ? undefined : String(record.by),
        };
      }).filter(waiver => waiver.id.length > 0);
    }

    const verify = asRecord(raw.verify);
    if (typeof verify.command === "string") policy.verify.command = verify.command;
    if (typeof verify.expectExitCode === "number") policy.verify.expectExitCode = verify.expectExitCode;
    if (typeof (verify.timeoutMs ?? verify["timeout-ms"]) === "number") {
      policy.verify.timeoutMs = Number(verify.timeoutMs ?? verify["timeout-ms"]);
    }
    if (verify.repairs === "env" || verify.repairs === "all") policy.verify.repairs = verify.repairs;

    const sarif = asRecord(raw.sarif);
    if (typeof sarif.out === "string") policy.sarif.out = sarif.out;

    const receipt = asRecord(raw.receipt);
    if (typeof receipt.out === "string") policy.receipt.out = receipt.out;

    return { ...policy, raw };
  }
  return policy;
}

export function isSeverity(value: string): value is Severity {
  return value === "error" || value === "warning" || value === "info";
}

/**
 * Converts a small glob (`*`, `**`, `?`) into a regular expression.
 *
 * `*` matches anything — finding ids embed file paths (`env-mismatch:KEY:src/app.js:3`),
 * so a waiver like `env-mismatch:API_URL*` has to be able to reach across a `/`.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`);
}

/** True when the waiver has an `expires` date that is already in the past. */
export function isExpired(waiver: Waiver, now = new Date()): boolean {
  if (!waiver.expires) return false;
  const expiry = new Date(waiver.expires);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry.getTime() < now.getTime();
}
