import { globToRegExp, isExpired } from "./config.js";
const PRIORITY = { error: 0, warning: 1, info: 2 };
function matchesFinding(pattern, diagnosis) {
    const matchers = [globToRegExp(pattern)];
    // A bare rule id like "dependency" or "env-mismatch" should match the id prefix.
    matchers.push(globToRegExp(`${pattern}*`));
    matchers.push(globToRegExp(`${pattern}:*`));
    if (diagnosis.file) {
        matchers.push(globToRegExp(pattern));
    }
    return matchers.some(matcher => matcher.test(diagnosis.id)) ||
        matchers.some(matcher => matcher.test(diagnosis.category)) ||
        (diagnosis.file !== undefined && matchers.some(matcher => matcher.test(diagnosis.file.replaceAll("\\", "/"))));
}
/**
 * Applies `.envdoctor.yml`: ignore globs and time-boxed waivers.
 * Waivers that have passed their expiry stop suppressing findings — the finding
 * comes back, and the expiry itself is reported so it can be renewed deliberately.
 */
export function applyPolicy(diagnoses, policy, now = new Date()) {
    const active = [];
    const ignored = [];
    const waivered = [];
    const expiredWaivers = [];
    const liveWaivers = [];
    for (const waiver of policy.waivers) {
        if (isExpired(waiver, now)) {
            expiredWaivers.push({ id: waiver.id, expires: waiver.expires ?? "" });
            continue;
        }
        liveWaivers.push({ pattern: waiver.id, reason: waiver.reason, expires: waiver.expires, by: waiver.by });
    }
    for (const diagnosis of diagnoses) {
        if (policy.ignore.some(pattern => matchesFinding(pattern, diagnosis))) {
            ignored.push(diagnosis);
            continue;
        }
        const waiver = liveWaivers.find(entry => matchesFinding(entry.pattern, diagnosis));
        if (waiver) {
            waivered.push({ ...diagnosis, waivered: { by: waiver.by ?? "policy", reason: waiver.reason, expires: waiver.expires } });
            continue;
        }
        active.push(diagnosis);
    }
    active.sort((a, b) => PRIORITY[a.severity] - PRIORITY[b.severity] || a.title.localeCompare(b.title));
    return { active, ignored, waivered, expiredWaivers };
}
/** Highest severity that survives policy, or undefined when clean. */
export function worstSeverity(diagnoses) {
    return diagnoses.reduce((worst, diagnosis) => {
        if (!worst)
            return diagnosis.severity;
        return PRIORITY[diagnosis.severity] < PRIORITY[worst] ? diagnosis.severity : worst;
    }, undefined);
}
/**
 * Deterministic exit-code contract (stable across runs — this is what CI gates on):
 *   0 = no finding at or above `failOn`
 *   1 = at least one finding at or above `failOn`
 *   2 = invalid usage / policy could not be parsed
 */
export function evaluateGate(diagnoses, policy) {
    if (policy.failOn === "none")
        return { fail: false, code: 0, reason: "fail-on: none" };
    const threshold = PRIORITY[policy.failOn];
    const offending = diagnoses.filter(diagnosis => PRIORITY[diagnosis.severity] <= threshold);
    if (!offending.length) {
        return { fail: false, code: 0, reason: `no findings at or above "${policy.failOn}"` };
    }
    const errors = offending.filter(item => item.severity === "error").length;
    const warnings = offending.filter(item => item.severity === "warning").length;
    return {
        fail: true,
        code: 1,
        reason: `${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"} at or above "${policy.failOn}"`,
    };
}
