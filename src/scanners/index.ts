import { Diagnosis, ScanResult } from "../types.js";
import { scanEnv } from "./env.js";
import { scanNode } from "./node.js";
import { scanPython } from "./python.js";
import { scanRuntime } from "./runtime.js";

export async function scanAll(targetDir: string): Promise<ScanResult> {
  const groups = await Promise.all([
    scanNode(targetDir), scanPython(targetDir), scanEnv(targetDir), scanRuntime(targetDir),
  ]);
  const diagnoses: Diagnosis[] = groups.flat().sort((a, b) => {
    const priority = { error: 0, warning: 1, info: 2 };
    return priority[a.severity] - priority[b.severity] || a.title.localeCompare(b.title);
  });
  return { diagnoses, scannedAt: new Date().toISOString(), targetDir };
}
