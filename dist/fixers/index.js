import { bumpDependency } from "./bumpVersion.js";
import { installDependency } from "./installMissingDeps.js";
import { syncEnvVar } from "./syncEnvVar.js";
export async function fixDiagnosis(diagnosis, targetDir, progress) {
    if (!diagnosis.autoFixable)
        return { success: false, message: "This diagnosis needs human attention and cannot be auto-fixed." };
    const details = diagnosis.details ?? {};
    if (details.kind === "env-file" || details.kind === "env-var" || details.kind === "env-mismatch")
        return syncEnvVar(details.kind, targetDir, details.key, details.value, details.near);
    if ((details.manager === "npm" || details.manager === "pip") && details.package)
        return details.kind === "version" ? bumpDependency(details.manager, details.package + (details.manager === "npm" ? `@${details.range}` : ""), targetDir, progress) : installDependency(details.manager, details.package + (details.manager === "npm" ? `@${details.range}` : ""), targetDir, progress);
    return { success: false, message: "No safe fixer is registered for this diagnosis." };
}
