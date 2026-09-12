# Env Doctor

**Verified repair for development environments.**

Detect → **reproduce** → repair → **re-verify** → receipt.

Env Doctor finds the environment problems that make a repo fail on one machine and not
another — a variable the code reads but the template never declares, a lockfile that
drifted from the manifest, a runtime declaration that disagrees with the container — and
then it **runs your project's own reproduction command before and after each repair**.
A repair that cannot be shown to change the outcome is taken back, and the real blocker
is reported instead.

```console
$ env-doctor ./app --onboard
▶ reproduction: node scripts/preflight.js
  baseline exit 1 in 43ms · fingerprint 9ffb92751037
▶ repairing: Missing environment variable: ANALYTICS_KEY
  ⚠ placeholder injected — not claimed as verified
▶ repairing: Possible env var mismatch: DB_URL vs DATABASE_URL
  ✅ verified: exit 0 · fingerprint c7fbaed1bedb

Verdict: verified-green · repro exit 1 → 0 · 1 verified · 0 rolled back · 2 escalated
  receipt sha256:e5de9eff9580 · offline (0 network calls) · secrets printed: 0 · redacted: 1
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
| `env-doctor <path>` | Scan. Exit `1` when a finding is at or above `failOn`. |
| `env-doctor <path> --onboard` | **Verified repair loop**: reproduce → repair → re-verify → receipt. Exits `0` only on `red-to-green`. |
| `env-doctor <path> --fix` | Apply safe fixes without the verification loop (fast, less certain). |
| `env-doctor <path> --dry-run` | Show what would change. |
| `env-doctor fingerprint [path] --out fp.json` | Hashable model of this environment. |
| `env-doctor fingerprint [path] --diff other.json` | Structured drift report (dev vs CI). Exits `1` on any drift. |
| `env-doctor revert [path]` | Undo the last repair session, byte for byte, and verify the undo. `--list` shows sessions. |

Useful flags: `--json`, `--sarif`, `--sarif-out <file>`, `--policy <file>`,
`--fail-on error\|warning\|info\|none`, `--repairs env\|all`, `--receipt-out <file>`,
`--no-receipt`, `--ui`.

Exit codes are the contract: **0** clean, **1** findings (or unverified), **2** usage/policy error.

## The verified repair loop

1. **Reproduce.** Run the project's own check — `preflight`, `verify`, `smoke`,
   `check:env` or `doctor` from `package.json`, or `verify.command` from policy. The
   output is normalized (paths, timestamps, durations, pids, ports) and hashed.
2. **Repair one finding at a time**, snapshotting every file first.
3. **Re-run the reproduction** and compare fingerprints:
   - passes now → keep, `verified-green`;
   - the failure moved → keep, `progress-unverified`;
   - only a template value was available → keep, `flagged-placeholder`, and say so;
   - **identical failure → roll back the change** and escalate the real blocker.
4. **Emit a receipt** (`envdoctor-receipt.json`) and journal the undo.

`--repairs env` (the default) keeps the loop offline: no package installs, no network.
`--repairs all` additionally allows `npm`/`pip` installs, which are recorded in
`guarantees.egress` — the receipt never claims `offline: true` when an installer ran.

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

## Receipts

`envdoctor-receipt.json` (`env-doctor/receipt@1`) records the reproduction command, both
runs (exit code, duration, normalized fingerprint), every repair with its status and file
hashes, the file tree hash before and after, escalations, and the guarantee block:

```json
"guarantees": { "egress": [], "telemetry": "none", "offline": true,
                "secrets": { "printed": 0, "redacted": 1, "valuesHashed": true } }
```

The receipt id is a hash of the outcome (never a timestamp), so the same input and the
same result produce the same id. Secrets are redacted out of repair messages and
escalation reasons before the receipt is written, and `secrets.printed` is computed by
scanning the serialized artifact — it is a measurement, not a promise.

## Fixtures

| Fixture | Demonstrates |
|---|---|
| `landmine-db-url-app` | A cross-file env landmine: red → **verified green** repair, plus a placeholder that is refused. |
| `false-fix-rollback-app` | A plausible repair with **no measurable effect** → auto-rollback and the real blocker. |
| `policy-waivers-app` | Ignore by category, a live waiver, and a **lapsed** waiver re-activating a finding. |
| `auto-fixable-env-app` | Small offline app for the `--ui` dashboard. |
| `broken-node-app` | Missing dependency, version mismatch, `DB_URL`/`DATABASE_URL` drift, `.nvmrc` mismatch. |
| `missing-env-file-app`, `runtime-mismatch-app` | Missing `.env`; runtime declarations that need a human. |

## Architecture

```
src/cli.ts               commands, flags, exit-code contract
src/scanners/            node · python · env · runtime   (deterministic detection)
src/fixers/              env sync · installers · transaction journal + revert
src/verify/repro.ts      reproduction execution, normalization, redaction, signatures
src/verify/receipt.ts    receipt building + secret self-check
src/fingerprint/         environment fingerprint + structured diff
src/policy.ts            ignore / waivers / fail-on gate     src/config.ts  .envdoctor.yml
src/report/              terminal report · SARIF 2.1.0
src/commands/onboard.ts  the verified repair loop
src/server.ts + ui/      local dashboard (drop a folder, fix, download, revert)
```

## Development

```sh
npm run build      # tsc
npm test           # build + node --test dist/tests  (10 tests, execution-based)
npm run demo       # the full judging demo against scratch copies of the fixtures
```

## Roadmap

- **Provenance**: which commit introduced a drift, and how long it has been there.
- **Cross-artifact contracts**: Dockerfile, compose, CI matrix, devcontainer and k8s
  manifests checked against the same truth.
- **Container profiles**: fingerprint a container image, not just the host.
- **Fleet view**: collect receipts and fingerprints across repos to rank onboarding pain.
