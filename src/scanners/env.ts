import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { Diagnosis } from "../types.js";
import { looksLikePlaceholder } from "../util/placeholder.js";
import { envFileRepro, envPresenceRepro, placeholderRepro } from "../verify/repro-for.js";

type EnvMap = Map<string, string>;
function parseEnv(source: string): EnvMap {
  const values = new Map<string, string>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}
async function readEnv(filename: string): Promise<EnvMap | undefined> {
  try { return parseEnv(await fs.readFile(filename, "utf8")); } catch { return undefined; }
}
async function sourceFiles(targetDir: string): Promise<string[]> {
  const filter = ignore().add(["node_modules", ".git", "dist", "coverage"]);
  try { filter.add(await fs.readFile(path.join(targetDir, ".gitignore"), "utf8")); } catch { /* no ignore file */ }
  const found: string[] = [];
  async function visit(relative: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(path.join(targetDir, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (filter.ignores(child) || filter.ignores(`${child}/`)) continue;
      if (entry.isDirectory()) await visit(child);
      else if (/\.(?:ts|js|py)$/i.test(entry.name)) found.push(child);
    }
  }
  await visit("");
  return found;
}
function references(source: string): Array<{ key: string; line: number }> {
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  ];
  const result: Array<{ key: string; line: number }> = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) result.push({ key: match[1], line: source.slice(0, match.index).split(/\r?\n/).length });
  }
  return result;
}
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]++;
    for (let j = 1; j <= b.length; j++) { const old = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1)); last = old; }
  }
  return prev[b.length];
}
function likelyMatch(reference: string, candidates: Iterable<string>): string | undefined {
  const ref = reference.replace(/_/g, "").toLowerCase();
  let best: { key: string; score: number } | undefined;
  for (const key of candidates) {
    const candidate = key.replace(/_/g, "").toLowerCase();
    const score = distance(ref, candidate) / Math.max(ref.length, candidate.length);
    if (!best || score < best.score) best = { key, score };
  }
  return best && best.score <= 0.6 ? best.key : undefined;
}
export async function scanEnv(targetDir: string): Promise<Diagnosis[]> {
  const example = await readEnv(path.join(targetDir, ".env.example"));
  const env = await readEnv(path.join(targetDir, ".env"));
  const results: Diagnosis[] = [];
  if (example && !env) results.push({ id: "missing-env-file", category: "env", severity: "error", title: "No .env file found, but .env.example exists", message: "This project includes an environment template, but your local .env file is missing.", file: ".env.example", autoFixable: true, fixDescription: "Copy .env.example to .env", details: { kind: "env-file" }, repro: envFileRepro() });
  if (example && env) for (const [key, value] of example) if (!env.has(key)) results.push({ id: `missing-env-var:${key}`, category: "env", severity: "error", title: `Missing environment variable: ${key}`, message: `${key} is listed in .env.example but missing from .env.`, file: ".env", autoFixable: true, fixDescription: `Add ${key}=${value || "<REPLACE_ME>"} to .env`, details: { kind: "env-var", key, value }, repro: envPresenceRepro(key) });
  if (env) {
    for (const [key, value] of env) {
      if (!looksLikePlaceholder(value)) continue;
      results.push({
        id: `placeholder-env-value:${key}`, category: "env", severity: "warning",
        title: `Placeholder value in .env: ${key}`,
        message: `${key} is set to what looks like a template value ("${value}"). Every service that reads it will behave as if it were unconfigured.`,
        file: ".env", autoFixable: false,
        details: { kind: "placeholder", key },
        repro: placeholderRepro(key),
      });
    }
  }
  const declared = new Set([...(env?.keys() ?? []), ...(example?.keys() ?? [])]);
  const candidates = new Set([...(env?.keys() ?? []), ...(example?.keys() ?? [])]);
  for (const relative of await sourceFiles(targetDir)) {
    let source: string;
    try { source = await fs.readFile(path.join(targetDir, relative), "utf8"); } catch { continue; }
    for (const ref of references(source)) {
      if (declared.has(ref.key)) continue;
      const near = likelyMatch(ref.key, candidates);
      const displayPath = relative.replaceAll("/", path.sep);
      results.push(near ? {
        id: `env-mismatch:${ref.key}:${relative}:${ref.line}`, category: "env", severity: "warning",
        title: `Possible env var mismatch: ${ref.key} vs ${near}`,
        message: `Code references ${ref.key} but .env defines ${near}.`, file: displayPath, line: ref.line,
        autoFixable: true, fixDescription: `Add ${ref.key} to .env using the value from ${near}`,
        details: { kind: "env-mismatch", key: ref.key, value: env?.get(near) ?? example?.get(near) ?? "", near },
        repro: envPresenceRepro(ref.key),
      } : {
        id: `undefined-env-var:${ref.key}:${relative}:${ref.line}`, category: "env", severity: "warning",
        title: `Possibly undefined env var: ${ref.key}`,
        message: `Used in ${displayPath}:${ref.line} but not found in .env or .env.example`, file: displayPath, line: ref.line, autoFixable: false,
        repro: envPresenceRepro(ref.key),
      });
    }
  }
  return results;
}
