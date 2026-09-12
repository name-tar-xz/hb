# The live demo, and how to answer the judges

**The fixture we run live: `test-fixtures/crossfile-db-url-app`.**

Everything below is one command from a clean clone:

```sh
npm install && npm run demo
```

`scripts/demo.sh` copies each fixture into a scratch directory first, so the repo is
never modified and the demo can be replayed as many times as you like.

---

## Why this fixture wins the room

Three files, and none of them looks wrong on its own:

| File | Says |
|---|---|
| `src/config.js` | `process.env.DB_URL` — what the application reads |
| `deploy/platform.yaml` | the container is injected `DB_URL` — so the code is right |
| `.env.example` | declares the database as `DATABASE_URL` — the template drifted |

A fresh clone has no `.env` (it is gitignored), so the service cannot boot at all.

**Ask a text-suggestion tool "why won't this start?" and it proposes one of two things:**

1. *"Add `DATABASE_URL=...` to your `.env`"* — already declared there; nothing changes.
2. *"Rename `process.env.DB_URL` to `process.env.DATABASE_URL`"* — plausible, and it
   silences the local check, but the platform injects `DB_URL` into the container, so
   that edit breaks production to satisfy a local read. It rewrites your source on a guess.

Neither answer can be checked without running something. That is the whole argument, and
the fixture makes it in three files.

---

## The 3-minute stage script

### Beat 0 — show the landmine (15s)

Show the files, not the tool. Read the three lines above out loud, then:

> "Every file here is individually correct. The bug lives in the relationship between
> them, and a fresh clone has no `.env` at all."

### Beat 1 — a fresh clone is broken (10s)

```sh
npm ci && npm run preflight      # exit 1
FAIL[env.db_url] DB_URL is not set — the orders database cannot be reached
```

> "This is the state a new contributor starts from, and the state the judges start from.
> Exit code 1, from the app's own startup check."

### Beat 2 — onboard, and start the clock (30s)

```sh
env-doctor onboard .
```

Read the phase block, then land the line:

```
  clean install       316ms   ✔ npm ci --offline · offline
  scan                  4ms   2 finding(s)
  verify-repair       278ms   2 verified · 0 escalated · 0 network calls
  re-scan               6ms   0 finding(s) remaining

⏱  time to green: 854ms
```

> "Clean install, scan, repair, re-scan — **854 milliseconds** from a broken clone to a
> service that boots. And note the install: it came from cache. Zero network calls."

Point at the two repairs as they scroll past:

- `✅ verified: exit 9 → 0` — the `.env` did not exist, Node said so with its own exit code.
- `✅ verified: exit 1 → 0` — the variable the code reads is missing; now it is visible.

> "Every repair is an exit code that flipped. Not 'looks right' — measured."

### Beat 3 — the receipt, including what it did *not* touch (25s)

```sh
cat envdoctor-receipt.json
```

Four numbers to say out loud:

- `timeToGreen.ms` — the same clock the terminal printed.
- `networkCalls: 0` and `guarantees.secrets.envValuesPrinted: 0`.
- `bootstrap.offline: true`.
- `fileHashes.changed: [".env"]`

> "**Only `.env` changed.** `src/config.js`, `deploy/platform.yaml` and `.env.example`
> are byte-identical — the receipt carries the before/after hash of every file to prove
> it. A suggestion tool would have offered to rename `process.env.DB_URL`. We don't
> rewrite your code to make a check pass; we fix the observable failure and prove it."

### Beat 4 — the service actually starts (10s)

```sh
npm start
orders-api listening on :3000
  database orders-db.internal/orders (sslmode=require)
```

### Beat 4b — the fixed copy, if a judge asks for it (10s)

In the dashboard (`env-doctor . --ui`), **Download fixed copy** hands over a zip of the
repaired project. Open the receipt inside it: `fileHashes.changed: [".env"]` travelled
with the copy, so the judge can verify what changed without trusting the screen.

### Beat 5 — undo (10s)

```sh
env-doctor revert .
```

> "Every change is a transaction. `.env` did not exist before the repair, so reverting
> removes it — back to a clean clone, byte for byte."

### Beat 6 — the honesty beat (40s) — *this is the one they remember*

```sh
env-doctor ./rollback-fixture --onboard --repro project
```

> "Same-shaped env mismatch, but the real failure is a missing config file. It applies
> the fix, re-runs the reproduction, gets the **identical failure hash**, so it takes its
> own change back and escalates. Exit code stays red — correctly.
>
> A suggestion engine would have told you it fixed it. We measured, it didn't, so we
> undid it. A tool that can be wrong about this is dangerous in CI; that's why the
> measurement is the product."

### Beat 7 — dev vs CI (25s)

```sh
env-doctor fingerprint ./dev --diff ci.json
  declared   nvmrc         20 ≠ 22
  env        DATABASE_URL  value sha256:d38f813c ≠ value sha256:3a77bcc5
```

> "Value **hashes**, never values. This is the structured diff behind 'works on my
> machine', and it is safe to ship from CI to a dashboard."

### Beat 8 — the same findings as a CI gate (20s)

```sh
env-doctor ./target --sarif-out env-doctor.sarif
```

> "SARIF: the finding annotates the PR that caused it, waivers arrive as suppressions,
> and the exit code blocks the merge. Deterministic output is what makes that possible —
> a probabilistic model cannot be a required status check."

### Closing line

> "Copilot writes your code. We verify your environment — offline, reproducibly, with a
> receipt that says what we proved and what we refused to guess."

---

## Judge Q&A

**"Copilot can already do this."**
> "Watch it try this fixture. The two plausible answers are both wrong: `DATABASE_URL` is
> already in the template, and renaming the code breaks the container, which is injected
> `DB_URL`. Copilot cannot run your preflight, cannot read its exit code, and cannot tell
> you which of the two edits is safe. We ran it and showed you: exit 1 → 0, and only
> `.env` changed."

**"Wouldn't Copilot just add this?"**
> "It has no execution environment, so it cannot produce a receipt or a time-to-green.
> And `.env` files are secrets: regulated teams cannot paste them into a hosted model at
> all. Ours never leaves the machine — `envValuesPrinted: 0, networkCalls: 0`, both
> measured."

**"Isn't this just a linter?"**
> "A linter reports. This runs a clean install, runs your app's own check, repairs, runs
> it again, and prints how long the whole thing took — with an undo and a hash-verified
> receipt. Ask a linter whether its own fix worked."

**"Why should we trust the 854ms?"**
> "Re-run it. The phases in the receipt are measured around the work, not estimated, and
> the receipt id is a hash of the outcome rather than a timestamp — same input, same
> result, same id. `npm test` runs the whole journey on fixtures, 23 tests."

**"What if the real fix is to change the code?"**
> "Then change it deliberately — that's your call. We won't make that call silently, and
> we won't rewrite application code to satisfy a local check. We fix what is provably
> wrong (the missing configuration), prove the service boots, and tell you what's left."

**"What's the moat?"**
> "The verification corpus and the rule packs, plus the fingerprint: once a team pushes
> fingerprints from dev, CI and prod, drift becomes comparable org-wide — a data asset,
> not a prompt."

**"What is actually built?"**
> `onboard` (clean install → scan → verified repair → re-scan → time to green), a
> per-finding reproduction on every diagnosis, the exit-code-flip repair loop, scoped
> revert plus a full undo, v2 receipts with counts, hashes, file-change proof and
> guarantees, a network-call ledger, env-value-hash fingerprints with a structured diff,
> policy (fail-on, ignore, expiring waivers), SARIF output, a local dashboard, and 23
> execution-based tests over seven fixtures.
> **Not built yet:** git-history provenance, container/k8s contract checks, fleet dashboard.

---

## Rehearsal checklist

- [ ] `npm install && npm run build` on the demo laptop **before** the pitch (the demo needs no network).
- [ ] `npm run demo` end to end once, reading the beats out loud (≈3 minutes).
- [ ] Have `env-doctor onboard .` typed and ready in a second terminal — beating the clock on stage is the moment.
- [ ] Re-run `npm run demo` right before going on: `timeToGreen` is real, and a cold cache would show a `npm ci` that goes to the network.
- [ ] Keep the receipt open in an editor for Beat 3 — pointing beats scrolling.
- [ ] Know the two lines by heart: *"only `.env` changed"* and *"the exit code did not flip, so we took the change back."*
