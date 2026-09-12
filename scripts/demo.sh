#!/usr/bin/env bash
#
# Env Doctor — the judging demo, end to end, in one command.
#
#   npm run demo
#
# The live fixture is `crossfile-db-url-app`: application code reads DB_URL, the
# platform injects DB_URL, and `.env.example` declares DATABASE_URL. Every fixture is
# copied to a scratch directory first, so the repo is never modified and the demo can
# be replayed as many times as you like.

set -u

cd "$(dirname "$0")/.."
CLI="node dist/cli.js"
FIXTURES="test-fixtures"
WORK="$(mktemp -d)"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
rule() { printf "\033[2m%s\033[0m\n" "──────────────────────────────────────────────────────────────"; }

if [ ! -f dist/cli.js ]; then
  echo "Building first…"
  npm run build >/dev/null || exit 1
fi

bold "0 · The landmine — three files, none of them wrong on its own"
cp -r "$FIXTURES/crossfile-db-url-app" "$WORK/app"
dim "  src/config.js      reads  process.env.DB_URL"
dim "  deploy/platform.yaml      injects DB_URL into the container  ← so the code is right"
dim "  .env.example       declares DATABASE_URL                     ← the template drifted"
dim "  .env               does not exist (gitignored): a clean clone has none"
dim "  scratch copy → $WORK/app"

bold "1 · A fresh clone is broken — the app's own check says so"
(cd "$WORK/app" && npm ci --no-audit --no-fund >/dev/null 2>&1)
dim "  \$ npm ci        (clean install: zero dependencies, so it installs offline)"
dim "  \$ npm run preflight"
(cd "$WORK/app" && npm run --silent preflight)
dim "  exit code: $?  ← this is the state a new contributor, and a judge, starts from"

bold "2 · onboard — clean install → scan → verify-repair → re-scan → time to green"
$CLI onboard "$WORK/app"; code=$?
dim "  exit code: $code  ← 0 means the app's own check passes and no finding is left"

bold "3 · What the receipt claims"
node -e '
const fs = require("node:fs");
const r = JSON.parse(fs.readFileSync(process.argv[1] + "/envdoctor-receipt.json", "utf8"));
console.log("  receipt id        ", r.id);
console.log("  time to green     ", r.timeToGreen.ms + "ms", "(green:", r.timeToGreen.green + ")");
console.log("  phases            ", Object.entries(r.timeToGreen.phases).map(([k, v]) => `${k}=${v}ms`).join(" "));
console.log("  bootstrap         ", `${r.bootstrap.command} · exit ${r.bootstrap.exitCode} · offline: ${r.bootstrap.offline} · network calls: ${r.bootstrap.networkCalls}`);
console.log("  findings          ", r.findings.count, "→", r.findings.remaining.length, "remaining");
console.log("  repairs           ", r.repairs.map(x => `${x.status}:${x.findingId.split(":")[0]}`).join(", "));
console.log("  verified/escalated", `${r.summary.repairsVerified} / ${r.summary.repairsEscalated}`);
console.log("  repro commands run", r.summary.reproCommandsRun);
for (const repair of r.repairs) {
  console.log("     ❯", repair.repro.command.slice(0, 96) + (repair.repro.command.length > 96 ? "…" : ""));
  console.log("       exit", repair.repro.before.exitCode, "→", repair.repro.after.exitCode,
    "· stdout sha256:" + repair.repro.after.stdoutHash.slice(0, 12));
}
console.log("  network calls     ", r.networkCalls, "(repair loop) · telemetry:", r.guarantees.telemetry);
console.log("  env values printed", r.guarantees.secrets.envValuesPrinted, "· redacted:", r.guarantees.secrets.redactedBeforePrinting + r.guarantees.secrets.redactedFromOutput);
console.log("  files changed     ", JSON.stringify(r.fileHashes.changed), "← .env only; src/, deploy/ and .env.example are byte-identical");
' "$WORK/app"

bold "4 · And the service actually starts"
(cd "$WORK/app" && timeout 3 npm run --silent start 2>&1 | head -3)
dim "  every claim above was earned by running something, not by reading it"

bold "5 · Undo — every change is a transaction"
dim "  .env before revert:"
sed 's/^/    /' "$WORK/app/.env"
$CLI revert "$WORK/app"
dim "  .env after revert:"
dim "    (the file is gone — it did not exist before the repair)"
ls "$WORK/app/.env" 2>/dev/null || echo "    no .env: back to a clean clone"

bold "6 · The honesty beat — a plausible fix that does nothing"
dim "  same-shaped env mismatch, but the real failure is a missing config file"
cp -r "$FIXTURES/false-fix-rollback-app" "$WORK/rollback"
$CLI "$WORK/rollback" --onboard --repro project; code=$?
dim "  Env Doctor applied the env fix, re-ran the reproduction, saw the identical failure,"
dim "  took its own change back, and named the actual blocker."
dim "  exit code: $code  ← still red, and correctly so: the environment was never the problem"

bold "7 · Dev vs CI — the diff behind \"works on my machine\""
cp -r "$FIXTURES/landmine-db-url-app" "$WORK/dev"
cp -r "$FIXTURES/landmine-db-url-app" "$WORK/ci"
printf '22\n' > "$WORK/ci/.nvmrc"
printf 'DATABASE_URL=postgres://db.ci.internal:5432/app?sslmode=require\n' > "$WORK/ci/.env"
$CLI fingerprint "$WORK/dev" --out "$WORK/dev.json" >/dev/null
$CLI fingerprint "$WORK/ci"  --out "$WORK/ci.json"  >/dev/null
$CLI fingerprint "$WORK/dev" --diff "$WORK/ci.json"
dim "  fingerprints carry value hashes, never values — safe to publish or share between teams"

bold "8 · The same findings as a CI gate (SARIF)"
cp -r "$FIXTURES/crossfile-db-url-app" "$WORK/ci-gate"
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
