/**
 * Env Doctor's own network-call ledger.
 *
 * Every place that can reach the network (currently: the npm and pip installers)
 * records itself here. The receipt reports the count, and the verified-repair loop
 * asserts it is zero unless installers were explicitly allowed with `--repairs all`.
 * This is a measurement, not a promise.
 */
const calls: string[] = [];

export function recordNetworkCall(description: string): void {
  calls.push(description);
}

export function networkCalls(): string[] {
  return [...calls];
}

export function networkCallCount(): number {
  return calls.length;
}

export function resetNetworkLedger(): void {
  calls.length = 0;
}
