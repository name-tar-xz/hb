import { Diagnosis } from "../types.js";
import { bumpDependency } from "./bumpVersion.js";
import { installDependency, Progress } from "./installMissingDeps.js";
import { syncEnvVar } from "./syncEnvVar.js";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function fixDiagnosis(diagnosis: Diagnosis, targetDir: string, progress?: Progress) {
  if (!diagnosis.autoFixable) return { success: false, message: "This diagnosis needs human attention and cannot be auto-fixed." };
  const details = diagnosis.details ?? {};
  if (details.kind === "env-file" || details.kind === "env-var" || details.kind === "env-mismatch") return syncEnvVar(details.kind, targetDir, details.key, details.value, details.near);
  if ((details.manager === "npm" || details.manager === "pip") && details.package) return details.kind === "version" ? bumpDependency(details.manager, details.package + (details.manager === "npm" ? `@${details.range}` : ""), targetDir, progress) : installDependency(details.manager, details.package + (details.manager === "npm" ? `@${details.range}` : ""), targetDir, progress);
  return { success: false, message: "No safe fixer is registered for this diagnosis." };
}

/**
 * The files a repair will write. Callers snapshot these first, so every repair
 * is reversible without guessing.
 */
export function filesTouchedBy(diagnosis: Diagnosis): string[] {
  const details = diagnosis.details ?? {};
  if (details.kind === "env-file" || details.kind === "env-var" || details.kind === "env-mismatch") return [".env"];
  if (details.manager === "npm") return ["package.json", "package-lock.json"];
  if (details.manager === "pip") return ["requirements.txt"];
  return diagnosis.file ? [diagnosis.file] : [];
}

/** True when the given files differ from their recorded content. */
export async function hasChangesBetween(
  targetDir: string,
  snapshots: Array<{ file: string; content: string | null }>,
): Promise<boolean> {
  for (const snapshot of snapshots) {
    let current: string | null = null;
    try {
      current = await fs.readFile(path.join(targetDir, snapshot.file), "utf8");
    } catch {
      current = null;
    }
    if (current !== snapshot.content) return true;
  }
  return false;
}
