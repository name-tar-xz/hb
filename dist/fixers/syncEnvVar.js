import { promises as fs } from "node:fs";
import path from "node:path";
import { looksLikePlaceholder } from "../util/placeholder.js";
import { createBackup } from "./backup.js";
export async function syncEnvVar(kind, targetDir, key, value, sourceKey) {
    const envPath = path.join(targetDir, ".env");
    await createBackup(targetDir, ".env");
    if (kind === "env-file") {
        try {
            await fs.copyFile(path.join(targetDir, ".env.example"), envPath);
            return { success: true, changed: true, message: "Added .env by copying .env.example." };
        }
        catch (error) {
            return { success: false, changed: false, message: error instanceof Error ? error.message : "Could not create .env." };
        }
    }
    if (!key)
        return { success: false, changed: false, message: "No environment variable was supplied." };
    let current = "";
    try {
        current = await fs.readFile(envPath, "utf8");
    }
    catch {
        try {
            current = await fs.readFile(path.join(targetDir, ".env.example"), "utf8");
        }
        catch {
            current = "";
        }
    }
    if (new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "m").test(current)) {
        return { success: true, changed: false, message: `${key} already exists in .env; nothing changed.` };
    }
    const injected = value || "<REPLACE_ME>";
    const addition = `${key}=${injected}`;
    await fs.writeFile(envPath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${addition}\n`);
    const placeholders = looksLikePlaceholder(injected) ? [{ key, value: injected }] : [];
    return {
        success: true,
        changed: true,
        placeholders,
        message: kind === "env-mismatch" && sourceKey
            ? `Matched ${key} to ${sourceKey} in .env:\n+ ${addition}`
            : `Added to .env:\n+ ${addition}`,
    };
}
