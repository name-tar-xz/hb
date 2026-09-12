import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";
import { promisify } from "node:util";
import { Diagnosis } from "../types.js";
const exec = promisify(execFile);

type Requirement = { name: string; operator?: string; version?: string };
function parseRequirements(source: string): Requirement[] {
  const parsed: Requirement[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*(==|>=|~=)?\s*([A-Za-z0-9_.+-]+)?/);
    if (match) parsed.push({ name: match[1], operator: match[2], version: match[3] });
  }
  return parsed;
}
async function pipFreeze(): Promise<string> {
  for (const command of process.platform === "win32" ? ["python", "py", "pip"] : ["python3", "python", "pip3", "pip"]) {
    try {
      const args = command === "pip" || command === "pip3" ? ["freeze"] : ["-m", "pip", "freeze"];
      return (await exec(command, args, { windowsHide: true })).stdout;
    } catch { /* next candidate */ }
  }
  throw new Error("pip unavailable");
}
function matches(version: string, operator?: string, expected?: string): boolean {
  if (!operator || !expected) return true;
  if (operator === "~=") {
    const parts = expected.split(".").map(Number);
    const index = Math.max(0, parts.length - 2);
    const upper = parts.slice(0, index + 1);
    upper[index] += 1;
    return semver.satisfies(version, `>=${expected} <${upper.join(".")}.0`, { loose: true });
  }
  return semver.satisfies(version, `${operator}${expected}`, { loose: true });
}
export async function scanPython(targetDir: string): Promise<Diagnosis[]> {
  let source: string;
  try { source = await fs.readFile(path.join(targetDir, "requirements.txt"), "utf8"); } catch { return []; }
  let frozen: string;
  try { frozen = await pipFreeze(); } catch {
    return [{ id: "python-scan-skipped", category: "runtime", severity: "info", title: "Python scanning skipped", message: "Python or pip is not available on this system.", autoFixable: false }];
  }
  const installed = new Map(frozen.split(/\r?\n/).map(line => line.split("==")).filter(parts => parts.length === 2).map(([name, version]) => [name.toLowerCase().replace(/[-_.]+/g, "-"), version]));
  const results: Diagnosis[] = [];
  for (const req of parseRequirements(source)) {
    const normalized = req.name.toLowerCase().replace(/[-_.]+/g, "-");
    const version = installed.get(normalized);
    const requirementText = `${req.name}${req.operator ?? ""}${req.version ?? ""}`;
    if (!version) results.push({ id: `missing-py-dep:${normalized}`, category: "dependency", severity: "error", title: `Missing Python dependency: ${req.name}`, message: `requirements.txt declares ${requirementText} but it is not installed`, file: "requirements.txt", autoFixable: true, fixDescription: `Run pip install ${requirementText}`, details: { package: requirementText, manager: "pip", kind: "missing" } });
    else if (!matches(version, req.operator, req.version)) results.push({ id: `py-version-mismatch:${normalized}`, category: "version", severity: "error", title: `Version mismatch: ${req.name}`, message: `requirements.txt wants ${requirementText}, but ${version} is installed`, file: "requirements.txt", autoFixable: true, fixDescription: `Run pip install ${requirementText}`, details: { package: requirementText, manager: "pip", kind: "version" } });
  }
  return results;
}
