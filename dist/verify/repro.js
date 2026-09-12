import { spawn } from "node:child_process";
import { sha256 } from "../util/hash.js";
const ANSI = /\u001b\[[0-9;]*m/g;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const CLOCK_TIME = /\b\d{2}:\d{2}:\d{2}\b/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g;
const HEX_ADDRESS = /\b0x[0-9a-fA-F]{4,}\b/g;
const PID = /\bpid[=: ]\s?\d+\b/gi;
const PORT = /localhost:\d{4,5}/g;
/**
 * Replaces known secret values with a marker. Used for captured process output,
 * for anything the pipeline prints, and for the receipt — a receipt is meant to be
 * attached to a PR or a ticket.
 */
export function redactSecrets(text, secrets) {
    let output = text;
    let count = 0;
    for (const secret of secrets) {
        if (!secret || secret.length < 4)
            continue;
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
/** True when the text contains any known secret value. */
export function containsSecret(text, secrets) {
    return secrets.filter(secret => secret.length >= 4 && text.includes(secret));
}
/**
 * Normalizes captured output so identical failures produce identical hashes across
 * machines, paths and runs. Paths, timestamps, durations, pids and ports are removed;
 * secret values are replaced before anything is hashed or reported.
 */
export function normalizeOutput(raw, options) {
    let text = raw.replace(ANSI, "");
    let redactions = 0;
    for (const secret of options.secrets ?? []) {
        if (!secret || secret.length < 4)
            continue;
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
const NOISE = /^(?:[\s}{\[\]]*|\s*(?:code|errno|syscall|path|stack):.*|\s*at .*|Node\.js v.*|\s*\^+\s*)$/;
const INFORMATIVE = /(?:^|\s)(?:error|fail|fatal|cannot find|enoent|econnrefused|exception|refus|denied|missing|not set|invalid|unable|timed? ?out|expected|assert)/i;
/**
 * Picks the lines that actually explain a failure instead of handing a human a
 * stack trace. Shown in the terminal report only — never stored in a receipt.
 */
export function summarizeFailure(text, fallbackLines = 3) {
    const lines = text.split("\n").map(line => line.trimEnd());
    const candidates = lines.filter(line => line.trim().length > 0 && !NOISE.test(line));
    const informative = candidates.filter(line => INFORMATIVE.test(line));
    const chosen = [];
    const add = (line) => {
        const trimmed = line.trim();
        if (!trimmed || chosen.includes(trimmed))
            return;
        chosen.push(trimmed);
    };
    if (informative.length) {
        for (const line of informative.slice(0, 2))
            add(line);
    }
    else {
        for (const line of candidates.slice(-fallbackLines))
            add(line);
    }
    return chosen.join("\n");
}
/**
 * Runs a reproduction command and records the exit code plus a hash of each stream.
 * Raw output is used transiently for the terminal signature and then dropped: the
 * evidence that leaves this function is `{ exitCode, stdoutHash, stderrHash, outputHash }`.
 */
export async function runRepro(options) {
    const args = options.args ?? [];
    const timeoutMs = options.timeoutMs ?? 60_000;
    const expectExitCode = options.expectExitCode ?? 0;
    const started = Date.now();
    return new Promise(resolve => {
        const finish = (stdout, stderr, exitCode, timedOut) => {
            const combined = normalizeOutput(`${stdout}\n${stderr}`, { cwd: options.cwd, secrets: options.secrets });
            const normalizedOut = normalizeOutput(stdout, { cwd: options.cwd, secrets: options.secrets });
            const normalizedErr = normalizeOutput(stderr, { cwd: options.cwd, secrets: options.secrets });
            const passed = exitCode === expectExitCode && !timedOut;
            const signature = timedOut
                ? `timed out after ${timeoutMs}ms`
                : passed
                    ? summarizeFailure(combined.text, 1)
                    : summarizeFailure(combined.text);
            resolve({
                command: options.command,
                args,
                cwd: options.cwd,
                exitCode,
                timedOut,
                durationMs: Date.now() - started,
                expectExitCode,
                stdoutHash: sha256(normalizedOut.text),
                stderrHash: sha256(normalizedErr.text),
                outputHash: sha256(combined.text),
                signature,
                redactions: combined.redactions,
            });
        };
        let child;
        try {
            child = spawn(options.command, options.shell ? [] : args, {
                cwd: options.cwd,
                windowsHide: true,
                shell: options.shell === true,
                env: { ...process.env, ...(options.env ?? {}), CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
            });
        }
        catch (error) {
            finish("", error instanceof Error ? error.message : "could not start the reproduction command", null, false);
            return;
        }
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        const collect = (target) => (chunk) => {
            const text = chunk.toString("utf8");
            if (target === "out") {
                if (stdout.length < 200_000)
                    stdout += text;
            }
            else if (stderr.length < 200_000)
                stderr += text;
        };
        child.stdout?.on("data", collect("out"));
        child.stderr?.on("data", collect("err"));
        child.on("error", error => {
            clearTimeout(timeout);
            finish(stdout, `${stderr}\n${error.message}`, null, false);
        });
        child.on("close", code => {
            clearTimeout(timeout);
            finish(stdout, stderr, code, timedOut);
        });
    });
}
/** Runs a `ReproSpec` (the per-finding reproduction recorded on a Diagnosis). */
export function runReproSpec(spec, cwd, options = {}) {
    return runRepro({
        command: spec.command,
        cwd,
        shell: spec.shell ?? true,
        expectExitCode: 0,
        timeoutMs: options.timeoutMs,
        secrets: options.secrets,
    });
}
/** True when the exit code flipped from non-zero to zero — the only definition of "verified". */
export function flippedToGreen(before, after) {
    return before.exitCode !== 0 && after.exitCode === 0 && !after.timedOut;
}
/** True when the failure changed but did not clear. Never sufficient to keep a change. */
export function failureMoved(before, after) {
    return before.outputHash !== after.outputHash || before.exitCode !== after.exitCode;
}
export function evidence(run) {
    return {
        exitCode: run.exitCode,
        stdoutHash: run.stdoutHash,
        stderrHash: run.stderrHash,
        outputHash: run.outputHash,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
    };
}
export const VERIFY_COMMAND_CANDIDATES = ["preflight", "verify", "smoke", "check:env", "doctor"];
/** Resolves `npm run <script>` for the first matching script in package.json. */
export function detectVerifyCommand(packageJson) {
    const scripts = packageJson?.scripts ?? {};
    for (const candidate of VERIFY_COMMAND_CANDIDATES) {
        if (scripts[candidate])
            return { command: "npm", args: ["run", "--silent", candidate] };
    }
    return undefined;
}
/** A short, stable label for a hash, for reports. */
export function shortHex(hash, length = 12) {
    return hash.slice(0, length);
}
