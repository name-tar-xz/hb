/**
 * Env Doctor's own network-call ledger.
 *
 * Every place that can reach the network (currently: the npm and pip installers)
 * records itself here. The receipt reports the count, and the verified-repair loop
 * asserts it is zero unless installers were explicitly allowed with `--repairs all`.
 * This is a measurement, not a promise.
 */
const calls = [];
export function recordNetworkCall(description) {
    calls.push(description);
}
export function networkCalls() {
    return [...calls];
}
export function networkCallCount() {
    return calls.length;
}
export function resetNetworkLedger() {
    calls.length = 0;
}
