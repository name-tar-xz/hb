# The demo, and how to answer the judges

Everything below runs offline, from a clean clone, with one command:

```sh
npm install && npm run demo
```

`scripts/demo.sh` copies each fixture into a scratch directory first, so the repo is
never modified and the demo can be replayed as many times as you like.

---

## The 3-minute stage script

### Beat 0 — the landmine (15s)

Show the fixture, not the tool:

```
.env.example declares:  DATABASE_URL
.env          contains: DATABASE_URL
the code reads:         DB_URL
```

> "Three files. None of them looks wrong on its own. This service will not start, and
> the fix is not obvious from any single file."

### Beat 1 — every finding ships with its own reproduction (15s)

```sh
node dist/cli.js /tmp/app
```

> "Each finding carries the command that reproduces it and the exit code it fails with:
> `node --env-file=.env -e '…process.env.DB_URL…'` — the variable read the way the app
> reads it. Exit code 1. That exit code is the whole product for CI."

### Beat 2 — reproduce, repair, re-verify (30s)

```sh
node dist/cli.js /tmp/app --onboard
```

Point at three lines in the output:

- `✅ verified: exit 1 → 0 · stdout b5a970a31f6b` — the exit code **flipped**, and the
  stdout hash changed; that is the definition of kept.
- `+ DB_URL=«redacted»` — it shows what it wrote, with the value redacted.
- `⚠ value for ANALYTICS_KEY is a template placeholder` — a template value is never
  quietly passed off as a real credential.

> "Copilot will suggest an edit to these files. It cannot tell you whether the service
> starts now. We can, because we ran it — and here is the proof."

### Beat 3 — the receipt (20s)

```sh
cat /tmp/app/envdoctor-receipt.json
```

> "Findings, repairs applied, repairs verified, the repro commands that ran, network
> calls **0**, env values printed **0** — and the proof for each repair is an exit code
> plus a `stdoutHash`/`stderrHash`. Raw output is never stored, so this file is safe to
> attach to a PR or a ticket."

### Beat 4 — the undo (15s)

```sh
node dist/cli.js revert /tmp/app
```

> "Every repair is a transaction. The `.env` is byte-for-byte what it was, and the undo
> is verified against the hashes recorded before the change."

### Beat 5 — the honesty beat (40s) — *this is the one they will remember*

```sh
node dist/cli.js /tmp/rollback --onboard --repro project
```

> "Same-shaped env mismatch, but the reproduction is the project's own check. The fix is
> applied, the check is re-run, the exit code does **not** flip — `exit 1 → 1 (identical)`
> — so the change is taken back out of the backup store and escalated. Nothing unproven
> is left in the repo.
>
> Run it without `--repro project` and you get the finer-grained answer: the variable
> fix is genuinely verified, *and* it still tells you the app fails for a reason that is
> not an environment variable. A suggestion engine would have told you it fixed it. We
> measured."

### Beat 6 — dev vs CI (25s)

```sh
node dist/cli.js fingerprint /tmp/dev --out /tmp/dev.json
node dist/cli.js fingerprint /tmp/ci  --out /tmp/ci.json
node dist/cli.js fingerprint /tmp/dev --diff /tmp/ci.json
```

> "Two fingerprints: declared runtime, resolved dependency versions, and hashes of every
> environment value. This is the structured diff behind 'works on my machine' — and
> because it holds hashes, it is safe to ship from CI to a dashboard."

### Beat 7 — the gate (20s)

```sh
node dist/cli.js /tmp/ci-gate --sarif-out ci.sarif
```

> "SARIF: the same finding annotates the pull request that introduced it, policy waivers
> arrive as suppressions, and the exit code blocks the merge. Deterministic output is
> what makes that possible — a probabilistic model cannot be a required status check."

### Closing line

> "Copilot writes code. We verify environments — offline, reproducibly, with a receipt
> that says what we proved and what we refused to guess."

---

## Judge Q&A

**"Copilot can already do this."**
> "We use Copilot — for writing the fix. Copilot cannot execute your preflight and read
> the exit code, cannot diff your machine against CI, and cannot be a required merge
> check with byte-stable output. Generation and verification are different products.
> Watch: it applied a fix, ran it, the failure did not move, and it took the fix back."

**"Wouldn't Copilot just add this?"**
> "A suggestion engine has no execution environment, so it cannot produce a receipt.
> And the payload problem is structural: `.env` files are secrets. Regulated teams
> cannot paste them into a hosted model at all. Ours never leaves the machine —
> `offline: true, egress: []` is printed on every receipt."

**"Isn't this just a linter?"**
> "A linter reports. We reproduce, repair, and re-verify atomically, with an undo and a
> hash-verified receipt. Ask a linter whether its own fix worked."

**"How is this different from `npm ci` / `docker compose`?"**
> "Those enforce one tool's view of one artifact. We check that the runtime declarations,
> the lockfile, the env template, the code's actual `process.env` reads, and the
> runtime's own values all agree — and we prove it by running the project's own
> reproduction command."

**"What's the moat?"**
> "The verification corpus and the rule packs, plus the fingerprint: once a team pushes
> fingerprints from dev, CI and prod, drift becomes comparable org-wide. That is a data
> asset, not a prompt."

**"What is actually built?"**
> A per-finding reproduction on every diagnosis, an exit-code-flip-only repair loop, scoped
> revert through the backup journal, v2 receipts with counts + hashes + guarantees, a
> network-call ledger, env-value-hash fingerprints with a structured diff, policy
> (fail-on, ignore, time-boxed waivers), SARIF output, transaction-based undo, and 18
> automated tests over six fixtures. Not built yet: git-history provenance, container/k8s
> contract checks, fleet dashboard.

**"Why should we trust the numbers on screen?"**
> "Re-run it. The receipt id is a hash of the outcome, not a timestamp — same input, same
> id. The reproduction fingerprints are normalized for path, timestamp, duration, pid and
> port, so they are stable across machines. `npm test` runs the whole loop on fixtures."

---

## Rehearsal checklist

- [ ] `npm install && npm run build` on the demo laptop, **before** the pitch (no network needed on stage).
- [ ] `npm run demo` end to end, once, while reading the beats out loud (≈3 minutes).
- [ ] Have `dist/cli.js /tmp/app --json` ready in a second terminal if a judge asks for raw output.
- [ ] Keep the receipt open in an editor for Beat 3 — pointing beats scrolling.
- [ ] Know the rollback fixture line by heart: *"the exit code did not flip, so we took the change back."*
