import { spawn } from "node:child_process";
import path from "node:path";
import { createBackup } from "./backup.js";
export async function installDependency(manager, pkg, targetDir, progress) {
    if (manager === "npm") {
        await createBackup(targetDir, "package.json");
        await createBackup(targetDir, "package-lock.json");
    }
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const command = manager === "npm" && process.platform === "win32" ? process.execPath : manager === "npm" ? "npm" : process.platform === "win32" ? "python" : "python3";
    const npmArgs = ["install", pkg, "--prefer-offline", "--fetch-timeout=15000", "--fetch-retries=1", "--no-audit", "--no-fund"];
    const args = manager === "npm" ? (process.platform === "win32" ? [npmCli, ...npmArgs] : npmArgs) : ["-m", "pip", "install", pkg];
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(command, args, { cwd: targetDir, windowsHide: true });
        }
        catch (error) {
            resolve({ success: false, message: error instanceof Error ? error.message : "Could not start the installer." });
            return;
        }
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
        child.stdout.on("data", data => progress?.(data.toString()));
        child.stderr.on("data", data => progress?.(data.toString()));
        child.on("error", error => { clearTimeout(timeout); resolve({ success: false, message: error.message }); });
        child.on("close", code => { clearTimeout(timeout); resolve(timedOut ? { success: false, message: "Installer timed out after one minute." } : code === 0 ? { success: true, message: `${manager} install completed successfully.` } : { success: false, message: `${manager} install failed (exit code ${code}). Check that the package is available locally.` }); });
    });
}
