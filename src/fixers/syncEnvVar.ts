import { promises as fs } from "node:fs";
import path from "node:path";
import { FixResult } from "../types.js";

export async function syncEnvVar(kind: string, targetDir: string, key?: string, value?: string): Promise<FixResult> {
  const envPath = path.join(targetDir, ".env");
  if (kind === "env-file") {
    try { await fs.copyFile(path.join(targetDir, ".env.example"), envPath); return { success: true, message: "Added .env by copying .env.example." }; }
    catch (error) { return { success: false, message: error instanceof Error ? error.message : "Could not create .env." }; }
  }
  if (!key) return { success: false, message: "No environment variable was supplied." };
  let current = "";
  try { current = await fs.readFile(envPath, "utf8"); } catch {
    try { current = await fs.readFile(path.join(targetDir, ".env.example"), "utf8"); }
    catch { current = ""; }
  }
  if (new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "m").test(current)) return { success: true, message: `${key} already exists in .env; nothing changed.` };
  const addition = `${key}=${value || "<REPLACE_ME>"}`;
  await fs.writeFile(envPath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${addition}\n`);
  return { success: true, message: `Added to .env:\n+ ${addition}` };
}
