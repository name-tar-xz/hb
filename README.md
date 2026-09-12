# Env Doctor

**Verified repair for development environments.**

Detect → **reproduce** → repair → **re-verify** → receipt.

Every finding a scanner reports carries its own **reproduction**: a command that shows
the failure, and the exit code it fails with. Before a fix is applied the command is run
and its output is hashed. After the fix it is run again. **The change is kept only if the
exit code flips from non-zero to zero** — anything else is escalated and the change is
taken back out of the backup store, so nothing unproven is ever left behind.

```console
$ env-doctor ./app --onboard
▶ Missing environment variable: ANALYTICS_KEY
  ✅ verified: exit 1 → 0 · stdout b5a970a31f6b
  + ANALYTICS_KEY=«redacted»
▶ Possible env var mismatch: DB_URL vs DATABASE_URL
  ✅ verified: exit 1 → 0 · stdout 181418506601
  + DB_URL=«redacted»

Verdict: verified-green · 2 findings · 2 applied · 2 verified · 0 escalated · 6 repro runs
  receipt sha256:8696bc81293b · offline · network calls: 0 · env values printed: 0 · redacted before printing: 1
```

## Why this exists (and why it isn't a linter with a chat box)

| | Suggestions (Copilot, linters) | Env Doctor |
|---|---|---|
| Output | "this looks wrong, try this" | Rule id, evidence, and an **executed** before/after |
| Verification | none — you check it | runs the reproduction, keeps the repair only if the outcome moves |
| Wrong fixes | silently plausible | **rolled back automatically** |
| Your machine | not modelled | fingerprint: runtime, resolved deps, env value hashes |
| Secrets | `.env` content is sent to a model | never leaves the machine; values are hashed, output is redacted |
| CI | no exit-code contract | stable exit codes, SARIF, policy with expiring waivers |
| Reproducibility | re-asking gives a different answer | byte-stable output — it can be a required status check |

The claim is narrow on purpose: **we don't guess, we measure.** See `DEMO.md` for the
three-minute demo that shows a plausible repair being measured, rejected, and undone.

## Install

```sh
npm install
npm run build
npx env-doctor <path>            # or: npm run demo
```

## Commands

| Command | What it does |
|---|---|
| `env-doctor onboard [path]` | **Clean install → scan → verified repair → re-scan**, then report the elapsed time as **time to green**. Exit `0` only when the gate passes *and* the app's own check passes. |
| `env-doctor <path>` | Scan. Exit `1` when a finding is at or above `failOn`. |
| `env-doctor <path> --onboard` | **Verified repair loop**: run each finding's repro → repair → run it again → keep only on a non-zero → zero flip. Exits `0` only when the verdict is `verified-green`. |
| `env-doctor <path> --fix` | Apply safe fixes without the verification loop (fast, less certain). |
| `env-doctor <path> --dry-run` | Show what would change. |
| `env-doctor fingerprint [path] --out fp.json` | Hashable model of this environment. |
| `env-doctor fingerprint [path] --diff other.json` | Structured drift report (dev vs CI). Exits `1` on any drift. |
| `env-doctor revert [path]` | Undo the last repair session, byte for byte, and verify the undo. `--list` shows sessions. |

`onboard` flags: `--no-install` (fully offline run), `--install-command <cmd>`, `--repro finding\|project`.

Useful flags: `--json`, `--sarif`, `--sarif-out <file>`, `--policy <file>`,
`--fail-on error\|warning\|info\|none`, `--repairs env\|all`,
`--repro finding\|project`, `--receipt-out <file>`, `--no-receipt`, `--ui`.

Exit codes are the contract: **0** clean, **1** findings (or unverified), **2** usage/policy error.

## Time to green

```console
$ env-doctor onboard .
▶ clean install        npm ci --offline ✔ in 316ms (offline)
▶ scan                2 finding(s) in 4ms
▶ project reproduction: npm run --silent preflight → exit 1
▶ No .env file found, but .env.example exists
  ✅ verified: exit 9 → 0 · stdout e3b0c44298fc
▶ Possible env var mismatch: DB_URL vs DATABASE_URL
  ✅ verified: exit 1 → 0 · stdout 181418506601
▶ project reproduction after repairs: exit 0
▶ re-scan             0 finding(s) in 6ms

🩺 Env Doctor — Onboard
──────────────────────────────────────────────
  clean install       316ms   ✔ npm ci --offline · offline
  scan                  4ms   2 finding(s)
  verify-repair       278ms   2 verified · 0 escalated · 0 network calls
  re-scan               6ms   0 finding(s) remaining

⏱  time to green: 854ms
   0 network calls (install was offline) · repair loop: 0 network call(s)
```

The clean install tries **`npm ci --offline` first**: a locked, cached or dependency-free
repo installs without touching the registry, and the report says so. Only if that fails
does it go to the network, and then the call is counted. `--no-install` skips the phase
entirely for a fully offline run.

Green means two things, both measured: **the policy gate passes** and **the app's own
check exits 0**. The phase timings and the total land in the receipt as
`timeToGreen` / `bootstrap`, so the number in the demo is the number in the artifact.

## The verified repair loop

Every `Diagnosis` from `src/scanners/*` carries a `repro` field:

```json
"repro": {
  "command": "node --env-file=.env -e 'const k=\"DB_URL\"; if(!process.env[k]){…process.exit(1)}'",
  "expectedFailingExitCode": 1,
  "source": "generated"
}
```

Reproductions are generated per finding category and are offline by construction:

| Finding | Reproduction |
|---|---|
| env var missing / mismatched | `node --env-file=.env -e '…'` — reads the variable the way the app does |
| placeholder value in `.env` | the same, with the template pattern asserted |
| `.env` missing | `node --env-file=.env` itself, which exits `9` when the file is unreadable |
| npm dependency missing / mismatched | `npm ls "<pkg>" --depth=0` — npm's own resolution check, exits `1` |
| pip dependency missing | `python3 -m pip show "<pkg>"` |
| runtime declared vs running | a version check against `.nvmrc` / `engines` / `requires-python` |

Then, per finding:

1. **Run the repro.** Record the exit code and a **hash of stdout and stderr** — raw
   output is never stored. Hash normalization removes paths, timestamps, durations,
   pids and ports so the same failure hashes identically on two machines.
2. **Refuse to act if it does not reproduce.** If the command already exits `0`, the
   finding is escalated untouched: no files are changed on a hunch.
3. **Apply the fix** through the existing fixers, with every touched file journaled by
   `backup.ts` first.
4. **Run the same command again.**
   - exit `non-zero → 0` → **verified**, kept.
   - anything else → **escalated**, and `revertTo(mark)` restores exactly this repair's
     files. A later escalation never disturbs an earlier verified repair.
5. **Ask the project's own check afterwards** (`preflight`/`verify`/`smoke`/`check:env`/
   `doctor`, or `verify.command`): if the app still fails, that is reported too — a
   verified repair means *"this finding is fixed"*, not *"your app works"*.
6. **Emit the receipt** and journal the undo.

`--repro project` runs the project's script as the reproduction for every finding
(stricter: a fix that cannot move the app's own check is rolled back).

`--repairs env` (the default) keeps the loop offline. `--repairs all` additionally allows
`npm`/`pip` installs; every potential network call is recorded in a ledger and reported as
`networkCalls`, so the receipt never claims `offline: true` when an installer ran.

## Fingerprints

```console
$ env-doctor fingerprint ./dev --diff ci.json
✗ Environments differ — fp_3486c53e4df6 vs fp_e4ea082243c2

  declared   nvmrc         20 ≠ 22
  env        DATABASE_URL  value sha256:d38f813c ≠ value sha256:3a77bcc5
```

A fingerprint contains runtime versions, declared versions (`.nvmrc`, `engines`),
resolved dependency versions, and **sha256 hashes of environment values — never the
values**. Same machine, same repo → same id. Different machine → a diff that names the
difference instead of saying "works on my machine".

## Policy — `.envdoctor.yml`

```yaml
failOn: error                 # error | warning | info | none

verify:
  command: node scripts/preflight.js   # optional; auto-detected otherwise
  expectExitCode: 0
  timeoutMs: 20000
  repairs: env                 # env (offline) | all (allows installers)

ignore:                        # scope findings out; matches id, glob, file or category
  - runtime

waivers:                       # acknowledgements that expire on their own
  - id: env-mismatch:API_URL*  # glob over the finding id
    reason: "legacy name kept until the billing service migrates (PLAT-4412)"
    by: devx-platform
    expires: 2099-01-01
  - id: missing-env-var:LEGACY_TOKEN
    by: security
    expires: 2026-01-01        # in the past → the finding is active again, and the
                               # expiry itself is reported so it can't be forgotten
```

Waivers survive into SARIF as `suppressions`, so an acknowledgement made locally is
respected by the review tool that consumes the report.

## CI

```yaml
# .github/workflows/env.yml
- run: npm ci && npm run build && npm test
- run: node dist/cli.js . --sarif-out env-doctor.sarif
  continue-on-error: false          # exit 1 blocks the merge
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: env-doctor.sarif }
```

## The dashboard

```sh
env-doctor <path> --ui        # serves the folder you passed (PORT / ENV_DOCTOR_HOST honored)
```

Drop a folder to scan a private copy, or point the command at a project and act on it
directly. **Download fixed copy** packages the repaired project as a zip — available
once a repair has been applied, and never including the tool's own repair journal
(`.envdoctor-backups` holds the *previous* contents of every touched file, including
`.env`, so it is excluded along with `node_modules` and build output).

Downloads are blocked inside sandboxed previews: if no file appears, open the dashboard's
URL in its own browser tab and click again — the page tells you this when it detects it
is embedded.

## Receipts

`envdoctor-receipt.json` (`env-doctor/receipt@2`) is the artifact you attach to a PR:

```json
{
  "findings":  { "count": 2, "before": ["…"], "after": ["…"], "resolved": ["…"], "remaining": ["…"] },
  "summary":   { "repairsApplied": 2, "repairsVerified": 2, "repairsEscalated": 0,
                 "reproCommandsRun": 6, "reproCommands": ["…"] },
  "networkCalls": 0,
  "repairs": [{ "findingId": "…", "status": "verified", "rolledBack": false,
                "repro": { "command": "…", "expectedFailingExitCode": 1,
                           "before": { "exitCode": 1, "stdoutHash": "…", "stderrHash": "…" },
                           "after":  { "exitCode": 0, "stdoutHash": "…", "stderrHash": "…" },
                           "flipped": true, "failureMoved": true } }],
  "fileHashes": { "before": { "…": "sha256:…" }, "after": { "…": "sha256:…" }, "changed": [".env"] },
  "guarantees": { "networkCalls": 0, "telemetry": "none", "offline": true,
                  "secrets": { "envValuesPrinted": 0, "redactedBeforePrinting": 1,
                               "redactedFromOutput": 1, "valuesHashed": true, "confirmed": true } },
  "bootstrap": { "command": "npm ci --offline", "exitCode": 0, "offline": true, "networkCalls": 0 },
  "timeToGreen": { "ms": 854, "green": true, "phases": { "installMs": 316, "repairMs": 278 } }
}
```

Reproduction output is represented by `stdoutHash` / `stderrHash` only; the raw content is
never written. Env var values are scrubbed out of repair messages and escalation reasons
before serialization, and `envValuesPrinted` is computed by scanning the finished
artifact for every value in the local env files — a measurement, not a promise. The
receipt id is a hash of the outcome (never a timestamp), so the same input and result
produce the same id.

## Fixtures

| Fixture | Demonstrates |
|---|---|
| **`crossfile-db-url-app`** | **The live demo fixture.** `src/config.js` reads `DB_URL`, `deploy/platform.yaml` injects `DB_URL`, `.env.example` declares `DATABASE_URL`, and a clean clone has no `.env`. A fresh copy cannot boot; `onboard` takes it to green offline, changing only `.env`. |
| `landmine-db-url-app` | A cross-file env landmine: two verified repairs, red → green, plus a placeholder that is kept only with a warning. |
| `false-fix-rollback-app` | A plausible repair that does not flip the repro → escalate + revert; the project check still fails and is reported. |
| `policy-waivers-app` | Ignore by category, a live waiver, and a **lapsed** waiver re-activating a finding. |
| `auto-fixable-env-app` | Small offline app for the `--ui` dashboard. |
| `broken-node-app` | Missing dependency, version mismatch, `DB_URL`/`DATABASE_URL` drift, `.nvmrc` mismatch. |
| `missing-env-file-app`, `runtime-mismatch-app` | Missing `.env`; runtime declarations that need a human. |

## Architecture

```
src/cli.ts               commands, flags, exit-code contract
src/scanners/            node · python · env · runtime   (deterministic detection)
src/fixers/              env sync · installers · backup journal (scoped revert + revertAll)
src/verify/repro-for.ts  per-finding reproduction commands (the `repro` field on findings)
src/verify/repro.ts      execution, stdout/stderr hashing, normalization, redaction
src/verify/receipt.ts    receipt building + secret self-check
src/fingerprint/         environment fingerprint + structured diff
src/policy.ts            ignore / waivers / fail-on gate     src/config.ts  .envdoctor.yml
src/report/              terminal report · SARIF 2.1.0
src/commands/onboard.ts  clean install → scan → loop → re-scan → time to green
src/commands/verified-repair.ts  the verified repair loop
src/util/network.ts      network-call ledger (installers + clean install)
src/server.ts + ui/      local dashboard (drop a folder or serve one, repair, download, revert)
```

## Development

```sh
npm run build      # tsc
npm test           # build + node --test dist/tests  (23 tests, execution-based)
npm run demo       # the full judging demo against scratch copies of the fixtures
```

## Roadmap

- **Provenance**: which commit introduced a drift, and how long it has been there.
- **Cross-artifact contracts**: Dockerfile, compose, CI matrix, devcontainer and k8s
  manifests checked against the same truth.
- **Container profiles**: fingerprint a container image, not just the host.
- **Fleet view**: collect receipts and fingerprints across repos to rank onboarding pain.
