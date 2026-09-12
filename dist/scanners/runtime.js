import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";
import { promisify } from "node:util";
const exec = promisify(execFile);
function nodeWarning(id, label, wanted, file) {
    const active = semver.coerce(process.version)?.version;
    const target = semver.coerce(wanted)?.version;
    if (!active || !target)
        return undefined;
    const matches = wanted.startsWith("v") || /^\d+(?:\.\d+){0,2}$/.test(wanted.trim()) ? active.split(".")[0] === target.split(".")[0] : semver.satisfies(active, wanted, { loose: true });
    return matches ? undefined : { id, category: "runtime", severity: "warning", title: `Node runtime mismatch: ${label}`, message: `${file} expects Node ${wanted.trim()}, but this session is running Node ${process.version}.`, file, autoFixable: false };
}
async function pythonVersion() {
    for (const command of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
        try {
            const result = await exec(command, ["--version"], { windowsHide: true });
            return `${result.stdout}${result.stderr}`.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
        }
        catch { /* next */ }
    }
}
export async function scanRuntime(targetDir) {
    const results = [];
    try {
        const wanted = await fs.readFile(path.join(targetDir, ".nvmrc"), "utf8");
        const issue = nodeWarning("node-nvmrc-mismatch", ".nvmrc", wanted, ".nvmrc");
        if (issue)
            results.push(issue);
    }
    catch { /* none */ }
    try {
        const pkg = JSON.parse(await fs.readFile(path.join(targetDir, "package.json"), "utf8"));
        if (pkg.engines?.node) {
            const issue = nodeWarning("node-engines-mismatch", "package engines", pkg.engines.node, "package.json");
            if (issue)
                results.push(issue);
        }
    }
    catch { /* none */ }
    let pythonRequirement;
    try {
        const pyproject = await fs.readFile(path.join(targetDir, "pyproject.toml"), "utf8");
        pythonRequirement = pyproject.match(/python_requires\s*=\s*["']([^"']+)["']/)?.[1] ?? pyproject.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1];
    }
    catch { /* none */ }
    if (pythonRequirement) {
        const active = await pythonVersion();
        if (active && !semver.satisfies(active, pythonRequirement, { loose: true }))
            results.push({ id: "python-runtime-mismatch", category: "runtime", severity: "warning", title: "Python runtime mismatch", message: `pyproject.toml expects Python ${pythonRequirement}, but this session is running Python ${active}.`, file: "pyproject.toml", autoFixable: false });
    }
    return results;
}
