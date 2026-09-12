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

### Beat 1 — detect, and own the exit code (15s)

```sh
node dist/cli.js /tmp/app
```

> "One error, one warning, exit code 1. That exit code is the whole product for CI."

### Beat 2 — reproduce, repair, re-verify (30s)

```sh
node dist/cli.js /tmp/app --onboard
```

Point at three lines in the output:

- `baseline exit 1 … fingerprint 9ffb92751037` — it ran the project's own preflight **before** touching anything.
- `✅ verified: exit 0` — the same command, re-run after the repair.
- `⚠ placeholder injected — not claimed as verified` — it filled a template value from `.env.example` and **refused to call that fixed**.

> "Copilot will suggest an edit to these files. It cannot tell you whether the service
> starts now. We can, because we ran it — and here is the proof."

### Beat 3 — the receipt (20s)

```sh
cat /tmp/app/envdoctor-receipt.json
```

> "`proof: red-to-green`, `repro exit 1 → 0`, `offline: true`, `egress: []`,
> `secrets printed: 0`. The receipt is deterministic, so it can be attached to a PR,
> and it contains value *hashes*, never values — safe to paste anywhere."

### Beat 4 — the undo (15s)

```sh
node dist/cli.js revert /tmp/app
```

> "Every repair is a transaction. The `.env` is byte-for-byte what it was, and the undo
> is verified against the hashes recorded before the change."

### Beat 5 — the honesty beat (40s) — *this is the one they will remember*

```sh
node dist/cli.js /tmp/rollback --onboard
```

> "Same-shaped env mismatch. Env Doctor applies the fix, re-runs the reproduction,
> gets the **identical failure fingerprint** — so it takes its own change back and tells
> you why: `Error: ENOENT … scripts/config/local.json`.
>
> A suggestion engine would have told you it fixed it. We measured. It didn't. So we
> undid it and escalated the real blocker. A tool that can be wrong about this is
> dangerous in CI; that is why we built the measurement."

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
> Verified repair loop with rollback and receipts, deterministic reproduction fingerprints,
> env-value-hash fingerprints with a structured diff, policy (fail-on, ignore, time-boxed
> waivers), SARIF output, transaction-based undo, 10 automated tests over six fixtures.
> Not built yet: git-history provenance, container/k8s contract checks, fleet dashboard.

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
- [ ] Know the rollback fixture line by heart: *"the change had no measurable effect, so we took it back."*
