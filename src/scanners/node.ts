import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";
import { Diagnosis } from "../types.js";

type PackageFile = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

export async function scanNode(targetDir: string): Promise<Diagnosis[]> {
  const manifestPath = path.join(targetDir, "package.json");
  let manifest: PackageFile;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { return []; }
  const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  const results: Diagnosis[] = [];
  for (const [pkg, range] of Object.entries(declared)) {
    const installedPath = path.join(targetDir, "node_modules", ...pkg.split("/"), "package.json");
    let installedVersion: string | undefined;
    try { installedVersion = JSON.parse(await fs.readFile(installedPath, "utf8")).version; } catch { /* missing */ }
    if (!installedVersion) {
      results.push({
        id: `missing-dep:${pkg}`, category: "dependency", severity: "error",
        title: `Missing dependency: ${pkg}`,
        message: `package.json declares ${pkg} (${range}) but it is not installed`, file: "package.json",
        autoFixable: true, fixDescription: `Run npm install ${pkg}@${range}`,
        details: { package: pkg, range, manager: "npm", kind: "missing" },
      });
    } else if (!semver.satisfies(installedVersion, range, { includePrerelease: true, loose: true })) {
      results.push({
        id: `version-mismatch:${pkg}`, category: "version", severity: "error",
        title: `Version mismatch: ${pkg}`,
        message: `package.json wants ${range}, but ${installedVersion} is installed`, file: "package.json",
        autoFixable: true, fixDescription: `Run npm install ${pkg}@${range}`,
        details: { package: pkg, range, manager: "npm", kind: "version" },
      });
    }
  }
  return results;
}
