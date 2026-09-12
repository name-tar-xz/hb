import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";
import { ReproSpec } from "../types.js";
import { detectVerifyCommand } from "./repro.js";

/** Exit code Node uses when `--env-file` points at a file it cannot read. */
export const EXIT_ENV_FILE_UNREADABLE = 9;
/** Generic "the check failed" exit code used by the generated commands. */
export const EXIT_CHECK_FAILED = 1;

/**
 * Wraps a JS one-liner for the shell. Generated payloads avoid quotes in the payload
 * itself, and the wrapper adapts to the platform's quoting rules.
 */
function nodeOneLiner(js: string, options: { envFile?: string } = {}): string {
  const evalFlag = process.platform === "win32" ? `-e "${js}"` : `-e '${js}'`;
  return options.envFile ? `node --env-file=${options.envFile} ${evalFlag}` : `node ${evalFlag}`;
}

function pythonExecutable(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/** Wraps a Python one-liner for the shell, adapting the quote style per platform. */
function pythonOneLiner(code: string): string {
  if (process.platform === "win32") return `${pythonExecutable()} -c "${code.replace(/"/g, "'")}"`;
  return `${pythonExecutable()} -c '${code.replace(/'/g, "")}'`;
}

/**
 * Per-finding reproductions.
 *
 * Every scanner attaches one of these to each Diagnosis: the exact command that shows
 * the failure, and the exit code it fails with while the finding is present. The
 * verified-repair loop runs it before and after a fix, and keeps the fix only if the
 * code flips from non-zero to zero.
 *
 * Commands are offline by construction: they read the project's files and the local
 * toolchain, nothing else.
 */

/** `.env` is missing or unreadable — Node itself exits 9 on an unreadable --env-file. */
export function envFileRepro(file = ".env"): ReproSpec {
  return {
    command: nodeOneLiner("process.exit(0)", { envFile: file }),
    expectedFailingExitCode: EXIT_ENV_FILE_UNREADABLE,
    source: "generated",
    shell: true,
  };
}

/**
 * The variable the code reads is not visible to the process at runtime.
 * The command reports what it found, so the stdout hash is meaningful: it changes
 * when the failure changes, and it is empty only when the check passes quietly.
 */
export function envPresenceRepro(key: string, envFileExists: boolean): ReproSpec {
  if (!envFileExists) return envFileRepro();
  const payload = `const k="${key}"; if(!process.env[k]){console.error("env.missing: "+k+" is not visible to this process");process.exit(1)} console.log("env.ok: "+k+" is visible")`;
  return {
    command: nodeOneLiner(payload, { envFile: ".env" }),
    expectedFailingExitCode: EXIT_CHECK_FAILED,
    source: "generated",
    shell: true,
  };
}

/** The variable is present but still holds a template value. */
export function placeholderRepro(key: string): ReproSpec {
  const pattern = "/^(<.*>|replace[-_ ]?me|changeme|change[-_ ]?me|your[-_ ].*|todo|xxx+|dummy|demo|test|fake|secret|password|placeholder|none|null)$/i";
  const payload = `const k="${key}",v=(process.env[k]||"").trim(); if(!v||${pattern}.test(v)){console.error("env.placeholder: "+k+" still holds a template value");process.exit(1)} console.log("env.ok: "+k+" holds a real value")`;
  return {
    command: nodeOneLiner(payload, { envFile: ".env" }),
    expectedFailingExitCode: EXIT_CHECK_FAILED,
    source: "generated",
    shell: true,
  };
}

/** npm's own resolution check: exits 1 for a missing or range-violating dependency. */
export function npmRepro(pkg: string): ReproSpec {
  return {
    command: `npm ls "${pkg}" --depth=0`,
    expectedFailingExitCode: EXIT_CHECK_FAILED,
    source: "generated",
    shell: true,
  };
}

/** pip show exits 1 when the distribution is not installed. */
export function pipShowRepro(name: string): ReproSpec {
  return {
    command: `${pythonExecutable()} -m pip show "${name}"`,
    expectedFailingExitCode: EXIT_CHECK_FAILED,
    source: "generated",
    shell: true,
  };
}

/**
 * Reproduces an installed-version mismatch for a pinned requirement. For ranges the
 * check compares the leading release components — enough to reproduce the failure,
 * and stated as an approximation rather than dressed up as full resolution.
 */
export function pipVersionRepro(name: string, operator?: string, version?: string): ReproSpec | undefined {
  if (!version) return undefined;
  const parts = version.split(".").map(Number).filter(value => Number.isFinite(value));
  const read = `v=m.version("${name}")`;
  let assertion: string;
  if (operator === "==") {
    assertion = `v=="${version}"`;
  } else if (operator === ">=" || operator === ">") {
    assertion = parts.length >= 2 ? `[int(x) for x in v.split(".")[:2]]${operator}[${parts[0]},${parts[1]}]` : `int(v.split(".")[0])${operator}${parts[0] ?? 0}`;
  } else {
    // ~=x.y and anything else: compare the declared prefix.
    assertion = parts.length >= 2 ? `v.startswith("${parts[0]}.${parts[1]}")` : `int(v.split(".")[0])==${parts[0] ?? 0}`;
  }
  return {
    command: pythonOneLiner(`import importlib.metadata as m,sys; ${read}; sys.exit(0 if ${assertion} else 1)`),
    expectedFailingExitCode: EXIT_CHECK_FAILED,
    source: "generated",
    shell: true,
  };
}

/** The runtime in this shell does not match what the repo declares. */
export function nodeRuntimeRepro(declared: string): ReproSpec | undefined {
  const major = semver.coerce(declared.trim())?.major;
  if (major === undefined) return undefined;
  const payload = `const m="${major}"; if(process.version.slice(1).split(".")[0]!==m){console.error("runtime.node: running "+process.version+", this repo declares major "+m);process.exit(1)} console.log("runtime.ok: node "+process.version)`;
  return {
    command: nodeOneLiner(payload),
    expectedFailingExitCode: EXIT_CHECK_FAILED,
    source: "generated",
    shell: true,
  };
}

/** The Python interpreter in this shell does not match the repo's declaration. */
export function pythonRuntimeRepro(declared: string): ReproSpec | undefined {
  const release = semver.coerce(declared.trim());
  if (!release) return undefined;
  const label = declared.trim().replace(/["']/g, "");
  const payload = [
    "import sys",
    `target=(${release.major},${release.minor ?? 0})`,
    "current=sys.version_info[:2]",
    `print("runtime.python: " + ".".join(map(str, current)) + " vs declared ${label}")`,
    "sys.exit(0 if current>=target else 1)",
  ].join("; ");
  return {
    command: pythonOneLiner(payload),
    expectedFailingExitCode: EXIT_CHECK_FAILED,
    source: "generated",
    shell: true,
  };
}

/**
 * The project's own check, when the repo has one. Used as the reproduction for findings
 * the scanners cannot express as a one-liner, and as the project-level guard run around
 * the whole repair session ("does the app actually work now?").
 */
export async function projectScriptRepro(targetDir: string): Promise<ReproSpec | undefined> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(targetDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const detected = detectVerifyCommand(manifest);
    if (!detected) return undefined;
    return {
      command: [detected.command, ...detected.args].join(" "),
      expectedFailingExitCode: EXIT_CHECK_FAILED,
      source: "project-script",
      shell: true,
    };
  } catch {
    return undefined;
  }
}

/** A ReproSpec from an explicit policy command. */
export function policyRepro(command: string): ReproSpec {
  return { command, expectedFailingExitCode: EXIT_CHECK_FAILED, source: "policy", shell: true };
}
