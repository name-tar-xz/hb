import { TOOL_NAME, TOOL_VERSION } from "../verify/receipt.js";
const RULE_BY_CATEGORY = {
    dependency: { id: "env-doctor/dependency", name: "MissingDependency", description: "A declared dependency is not installed." },
    version: { id: "env-doctor/version", name: "VersionMismatch", description: "An installed version does not satisfy the declared range." },
    env: { id: "env-doctor/environment", name: "EnvironmentVariable", description: "An environment variable is missing, mismatched, or a placeholder." },
    runtime: { id: "env-doctor/runtime", name: "RuntimeVersion", description: "Declared runtime versions disagree with this environment." },
};
const LEVEL = {
    error: "error",
    warning: "warning",
    info: "note",
};
/**
 * SARIF 2.1.0 so findings land as annotations on the PR that introduced them,
 * in the GitHub Security tab, or in any other SARIF consumer. Policy waivers
 * become SARIF `suppressions`, so a dismissed finding is dismissed *in the tool*
 * that reviews it — the same object enterprise review flows already understand.
 */
export function toSarif(result, options = {}) {
    const rules = new Map();
    const results = [];
    for (const diagnosis of result.diagnoses) {
        const rule = RULE_BY_CATEGORY[diagnosis.category];
        if (!rules.has(rule.id)) {
            rules.set(rule.id, {
                id: rule.id,
                name: rule.name,
                shortDescription: { text: rule.description },
                helpUri: `${options.informationUri ?? "https://github.com/name-tar-xz/hb"}#${diagnosis.category}`,
                properties: { category: diagnosis.category },
            });
        }
        const entry = {
            ruleId: rule.id,
            ruleIndex: [...rules.keys()].indexOf(rule.id),
            level: LEVEL[diagnosis.severity],
            message: { text: `${diagnosis.title}. ${diagnosis.message}` },
            properties: {
                "env-doctor/id": diagnosis.id,
                "env-doctor/autoFixable": diagnosis.autoFixable,
                "env-doctor/fix": diagnosis.fixDescription ?? null,
            },
        };
        if (diagnosis.file) {
            entry.locations = [{
                    physicalLocation: {
                        artifactLocation: { uri: diagnosis.file.replaceAll("\\", "/") },
                        ...(diagnosis.line ? { region: { startLine: diagnosis.line } } : {}),
                    },
                }];
        }
        if (diagnosis.waivered) {
            entry.suppressions = [{
                    kind: "external",
                    justification: `${diagnosis.waivered.by}: ${diagnosis.waivered.reason ?? "waived by policy"}${diagnosis.waivered.expires ? ` (expires ${diagnosis.waivered.expires})` : ""}`,
                }];
        }
        results.push(entry);
    }
    return {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [{
                tool: {
                    driver: {
                        name: TOOL_NAME,
                        version: TOOL_VERSION,
                        informationUri: options.informationUri ?? "https://github.com/name-tar-xz/hb",
                        rules: [...rules.values()],
                    },
                },
                ...(options.runId ? { automationDetails: { id: options.runId } } : {}),
                invocations: [{
                        executionSuccessful: true,
                        exitCode: options.exitCode ?? 0,
                        startTimeUtc: result.scannedAt,
                    }],
                results,
            }],
    };
}
