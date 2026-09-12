import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalize, sha256, shortHash } from "../util/hash.js";
import { readReceipt } from "../verify/receipt.js";
import { detectVerifyCommand } from "../verify/repro.js";
import { looksLikePlaceholder } from "../util/placeholder.js";
const exec = promisify(execFile);
export { looksLikePlaceholder };
async function commandVersion(command, args) {
    try {
        const result = await exec(command, args, { windowsHide: true, timeout: 5000 });
        const text = `${result.stdout}${result.stderr}`.trim();
        const match = text.match(/v?(\d+\.\d+\.\d+)/);
        return match ? match[1] : text.split("\n")[0];
    }
    catch {
        return undefined;
    }
}
async function readJson(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    }
    catch {
        return undefined;
    }
}
function parseEnvKeys(source) {
    const values = new Map();
    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (match)
            values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
    }
    return values;
}
async function lockfileDrift(targetDir) {
    const manifest = await readJson(path.join(targetDir, "package.json"));
    const lock = await readJson(path.join(targetDir, "package-lock.json"));
    if (!manifest || !lock)
        return [];
    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    const packages = lock.packages ?? {};
    const rows = [];
    for (const [name, range] of Object.entries(declared).sort(([a], [b]) => a.localeCompare(b))) {
        const locked = packages[`node_modules/${name}`]?.version;
        rows.push({
            file: "package-lock.json",
            package: name,
            declared: range,
            locked,
            drift: Boolean(locked) && !satisfiesMajor(range, locked),
        });
    }
    return rows;
}
/** Cheap lockfile check without pulling semver in here: exact pins and majors only. */
function satisfiesMajor(range, locked) {
    const pinned = range.match(/(\d+)\.(\d+)\.(\d+)/);
    if (pinned && /^[=v\d]/.test(range.trim()) && !range.includes("^") && !range.includes("~") && !range.includes(">") && !range.includes("<") && !range.includes("*")) {
        return `${pinned[1]}.${pinned[2]}.${pinned[3]}` === locked;
    }
    const wanted = range.match(/(\d+)/);
    const actual = locked.match(/(\d+)/);
    if (!wanted || !actual)
        return true;
    return wanted[1] === actual[1];
}
function lastOutcome(receipt) {
    if (!receipt)
        return undefined;
    if (receipt.projectRepro)
        return receipt.projectRepro.green ? "verified-green" : "failing";
    const verified = receipt.summary.repairsVerified;
    return verified > 0 ? `verified-green (${verified} repair${verified === 1 ? "" : "s"})` : "failing";
}
/**
 * A hashable model of the resolved environment: runtime versions, resolved
 * dependency versions, and the *hashes* of environment values (never the values).
 *
 * Two machines that agree on a fingerprint will behave the same way — so a
 * fingerprint mismatch is a structured, blamable difference: dev vs CI, or prod vs stage.
 */
export async function buildFingerprint(options) {
    const targetDir = path.resolve(options.targetDir);
    const [npm, python, lockfile] = await Promise.all([
        commandVersion("npm", ["--version"]),
        commandVersion(process.platform === "win32" ? "python" : "python3", ["--version"]),
        lockfileDrift(targetDir),
    ]);
    const keys = new Set();
    const envRows = [];
    for (const file of [".env.example", ".env"]) {
        try {
            const parsed = parseEnvKeys(await fs.readFile(path.join(targetDir, file), "utf8"));
            for (const [key, value] of parsed)
                keys.add(key);
            const present = new Map();
            for (const [key, value] of parsed)
                present.set(key, value);
            for (const [key, value] of present) {
                if (file === ".env") {
                    const row = envRows.find(item => item.key === key);
                    const entry = { key, present: true, valueHash: `sha256:${sha256(value).slice(0, 12)}`, placeholder: looksLikePlaceholder(value) };
                    if (row)
                        Object.assign(row, entry);
                    else
                        envRows.push(entry);
                }
            }
        }
        catch {
            /* file absent */
        }
    }
    const exampleKeys = new Set();
    try {
        for (const key of parseEnvKeys(await fs.readFile(path.join(targetDir, ".env.example"), "utf8")).keys())
            exampleKeys.add(key);
    }
    catch {
        /* no template */
    }
    const localKeys = new Set();
    try {
        for (const key of parseEnvKeys(await fs.readFile(path.join(targetDir, ".env"), "utf8")).keys())
            localKeys.add(key);
    }
    catch {
        /* no local env */
    }
    for (const key of [...exampleKeys].sort()) {
        if (localKeys.has(key))
            continue;
        envRows.push({ key, present: false, placeholder: undefined });
    }
    envRows.sort((a, b) => a.key.localeCompare(b.key));
    const manifest = await readJson(path.join(targetDir, "package.json"));
    let nvmrc;
    try {
        nvmrc = (await fs.readFile(path.join(targetDir, ".nvmrc"), "utf8")).trim().split("\n")[0].trim();
    }
    catch {
        nvmrc = undefined;
    }
    const engines = manifest?.engines;
    const detected = options.policy?.verify.command ? undefined : detectVerifyCommand(manifest);
    const verifyCommand = options.policy?.verify.command ?? (detected ? [detected.command, ...detected.args].join(" ") : undefined);
    const receipt = await readReceipt(path.join(targetDir, "envdoctor-receipt.json"));
    const fingerprint = {
        schema: "env-doctor/fingerprint@1",
        id: "",
        target: path.basename(targetDir) || targetDir,
        runtime: {
            node: process.version.replace(/^v/, ""),
            npm,
            python,
            platform: `${process.platform}-${process.arch}`,
            arch: process.arch,
        },
        declared: { nvmrc, enginesNode: engines?.node },
        lockfile,
        env: envRows,
        manifests: ["package.json", "package-lock.json", ".nvmrc", ".env.example", "requirements.txt", "Dockerfile", ".envdoctor.yml"]
            .filter(Boolean),
        verify: verifyCommand ? { command: verifyCommand, lastOutcome: lastOutcome(receipt) } : undefined,
        receipt: receipt ? { id: receipt.id, verdict: receipt.verdict } : null,
    };
    const identity = {
        target: fingerprint.target,
        runtime: fingerprint.runtime,
        declared: fingerprint.declared,
        lockfile: fingerprint.lockfile,
        env: fingerprint.env.map(row => ({ key: row.key, present: row.present, valueHash: row.valueHash, placeholder: row.placeholder })),
        verify: fingerprint.verify,
    };
    fingerprint.id = `fp_${shortHash(canonicalize(identity)).slice(7)}`;
    return fingerprint;
}
/**
 * Structured diff between two fingerprints. Deliberately reports *where* they
 * diverge and in which direction, because "works on my machine" is a diff, not a message.
 */
export function diffFingerprints(here, there) {
    const rows = [];
    const runtimeKeys = ["node", "npm", "python", "platform", "arch"];
    const declaredKeys = ["nvmrc", "enginesNode"];
    for (const key of declaredKeys) {
        const a = here.declared?.[key] ?? "(unset)";
        const b = there.declared?.[key] ?? "(unset)";
        if (a !== b)
            rows.push({ section: "declared", key, here: a, there: b });
    }
    for (const key of runtimeKeys) {
        const a = here.runtime[key] ?? "(absent)";
        const b = there.runtime[key] ?? "(absent)";
        if (a !== b)
            rows.push({ section: "runtime", key, here: a, there: b });
    }
    const lockIndex = (fingerprint) => new Map(fingerprint.lockfile.map(row => [row.package, row]));
    const herePackages = lockIndex(here);
    const therePackages = lockIndex(there);
    for (const name of [...new Set([...herePackages.keys(), ...therePackages.keys()])].sort()) {
        const a = herePackages.get(name);
        const b = therePackages.get(name);
        if (a?.locked !== b?.locked) {
            rows.push({ section: "dependency", key: name, here: a?.locked ?? "(absent)", there: b?.locked ?? "(absent)" });
        }
    }
    const envIndex = (fingerprint) => new Map(fingerprint.env.map(row => [row.key, row]));
    const hereEnv = envIndex(here);
    const thereEnv = envIndex(there);
    for (const key of [...new Set([...hereEnv.keys(), ...thereEnv.keys()])].sort()) {
        const a = hereEnv.get(key);
        const b = thereEnv.get(key);
        if (a?.present !== b?.present) {
            rows.push({ section: "env", key, here: a?.present ? "present" : "missing", there: b?.present ? "present" : "missing" });
        }
        else if (a?.valueHash !== b?.valueHash) {
            rows.push({ section: "env", key, here: "value sha256:" + (a?.valueHash?.slice(7, 15) ?? "?"), there: "value sha256:" + (b?.valueHash?.slice(7, 15) ?? "?") });
        }
    }
    return rows;
}
