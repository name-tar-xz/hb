#!/usr/bin/env bash
#
# Env Doctor — the judging demo, end to end, in one command.
#
#   npm run demo
#
# Every fixture is copied to a scratch directory first, so the repo is never
# modified and the demo can be re-run as many times as you like.

set -u

cd "$(dirname "$0")/.."
CLI="node dist/cli.js"
WORK="$(mktemp -d)"
FIXTURES="test-fixtures"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
rule() { printf "\033[2m%s\033[0m\n" "──────────────────────────────────────────────────────────────"; }

if [ ! -f dist/cli.js ]; then
  echo "Building first…"
  npm run build >/dev/null || exit 1
fi

bold "0 · Setup"
dim "  scratch copy of the landmine fixture → $WORK/app  (network is never used)"
cp -r "$FIXTURES/landmine-db-url-app" "$WORK/app"
rule
dim "  .env.example declares: DATABASE_URL"
dim "  .env          contains: DATABASE_URL"
dim "  the code reads:         DB_URL        <- nothing looks wrong on its own"
dim "  ANALYTICS_KEY is still a template value in .env.example"

bold "1 · Detect — the scan finds it and returns a CI exit code"
$CLI "$WORK/app"; code=$?
dim "  exit code: $code  ← a required status check can gate on this"

bold "2 · Reproduce, repair, re-verify"
$CLI "$WORK/app" --onboard; code=$?
dim "  exit code: $code  ← green: the reproduction was executed and observed to pass"

bold "3 · What the receipt actually claims"
node -e '
const fs = require("node:fs");
const r = JSON.parse(fs.readFileSync(process.argv[1] + "/envdoctor-receipt.json", "utf8"));
console.log("  receipt id     ", r.id);
console.log("  proof          ", r.verify.proof, `(repro exit ${r.verify.before.exitCode} → ${r.verify.after.exitCode})`);
console.log("  verdict        ", r.verdict);
console.log("  repairs        ", r.repairs.map(x => `${x.status}:${x.findingId.split(":")[1] ?? x.findingId}`).join(", "));
console.log("  escalated      ", r.escalation.length + " (refused to guess)");
console.log("  offline        ", r.guarantees.offline, "· egress:", JSON.stringify(r.guarantees.egress));
console.log("  secrets printed", r.guarantees.secrets.printed, "· redacted:", r.guarantees.secrets.redacted);
' "$WORK/app"
dim "  the receipt is safe to attach to a PR or a ticket: no secret values, only hashes"

bold "4 · Undo — every change is a transaction"
dim "  .env before revert:"
sed 's/^/    /' "$WORK/app/.env"
$CLI revert "$WORK/app"
dim "  .env after revert:"
sed 's/^/    /' "$WORK/app/.env"

bold "5 · The honesty beat — a plausible fix that does nothing"
dim "  same env mismatch, but the real failure is a missing config file"
cp -r "$FIXTURES/false-fix-rollback-app" "$WORK/rollback"
$CLI "$WORK/rollback" --onboard; code=$?
dim "  Env Doctor applied the env fix, re-ran the reproduction, saw the identical failure,"
dim "  took its own change back, and named the actual blocker."
dim "  exit code: $code  ← still red, and correctly so: the environment was never the problem"

bold "6 · Dev vs CI — the diff behind \"works on my machine\""
cp -r "$FIXTURES/landmine-db-url-app" "$WORK/dev"
cp -r "$FIXTURES/landmine-db-url-app" "$WORK/ci"
printf '22\n' > "$WORK/ci/.nvmrc"
printf 'DATABASE_URL=postgres://db.ci.internal:5432/app?sslmode=require\n' > "$WORK/ci/.env"
$CLI fingerprint "$WORK/dev" --out "$WORK/dev.json" >/dev/null
$CLI fingerprint "$WORK/ci"  --out "$WORK/ci.json"  >/dev/null
$CLI fingerprint "$WORK/dev" --diff "$WORK/ci.json"
dim "  fingerprints carry value hashes, never values — safe to publish or share between teams"

bold "7 · The same findings as a CI gate (SARIF)"
cp -r "$FIXTURES/landmine-db-url-app" "$WORK/ci-gate"
$CLI "$WORK/ci-gate" --sarif-out "$WORK/ci-gate.sarif"
node -e '
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const run = s.runs[0];
console.log("  sarif        ", s.version, "·", run.results.length, "result(s) ·", run.tool.driver.rules.length, "rule(s)");
for (const result of run.results) console.log("   ", result.level.padEnd(7), result.ruleId, "·", (result.locations?.[0]?.physicalLocation.artifactLocation.uri ?? "(repo-level)"));
console.log("  invocation   ", "exitCode", run.invocations[0].exitCode);
' "$WORK/ci-gate.sarif"
dim "  upload this file and the findings annotate the pull request that caused them"

printf "\n"
rule
bold "Demo complete — scratch files are in $WORK"
