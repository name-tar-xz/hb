import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
/** Short, human-readable content hash used in receipts and reports. */
export function shortHash(value) {
    return `sha256:${sha256(value).slice(0, 12)}`;
}
export async function hashFile(filePath) {
    try {
        return shortHash(await fs.readFile(filePath));
    }
    catch {
        return undefined;
    }
}
/** Recursively hashes a set of project files, skipping heavy directories. */
export async function hashTree(targetDir, options = {}) {
    // Tool scratch directories are never part of "what this repair changed".
    const skip = new Set([
        "node_modules", ".git", "dist", "coverage",
        ".envdoctor-backups", ".env-doctor-backups", ".envdoctor-work",
    ]);
    const hashes = {};
    let count = 0;
    const maxFiles = options.maxFiles ?? 500;
    async function visit(relative) {
        if (count >= maxFiles)
            return;
        let entries;
        try {
            entries = await fs.readdir(path.join(targetDir, relative), { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (count >= maxFiles)
                return;
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (skip.has(entry.name))
                    continue;
                await visit(child);
            }
            else if (entry.isFile()) {
                const hash = await hashFile(path.join(targetDir, child));
                if (hash) {
                    hashes[child] = hash;
                    count++;
                }
            }
        }
    }
    await visit("");
    return hashes;
}
/** Deterministic JSON: object keys sorted recursively, so a receipt id is reproducible. */
export function canonicalize(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value) ?? "null";
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(",")}]`;
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}
