# Orders API — `crossfile-db-url-app`

A deliberately broken fixture for the live demo. Every file is plausible on its own;
the bug only exists in the relationship between three of them.

| File | Says |
|---|---|
| `src/config.js` | `process.env.DB_URL` — the key the application reads |
| `deploy/platform.yaml` | the container is injected `DB_URL` — so the code is right |
| `.env.example` | declares the database as `DATABASE_URL` — the template drifted |

A fresh clone has no `.env` (it is gitignored), so the service cannot boot at all.

## What a text-suggestion tool does here

Asked "why won't this service start?", a completion model reads the two most similar
lines and proposes one of:

1. *"Add `DATABASE_URL=...` to your `.env`"* — it is already declared there; the
   suggestion changes nothing and the app still fails.
2. *"Rename `process.env.DB_URL` to `process.env.DATABASE_URL` in `src/config.js`"* —
   plausible, and it would silence the local check, but the platform injects
   `DB_URL` into the container, so this edit would break production to satisfy a
   local read. It also rewrites application code based on a guess.

Neither answer is checkable without running something.

## What Env Doctor does

It runs the service's own preflight, sees exit `1`, then applies the only repair that
is provable: it adds the missing key **to `.env`** using the value the template already
declares, re-runs the preflight, watches the exit code flip to `0`, and reports it.

`.env.example`, `src/`, and `deploy/` are left byte-identical — the receipt's file
hashes prove it. If you *decide* the code is the thing that is wrong, that is your
call to make deliberately; it is not one the tool makes silently.

## Run it yourself

```sh
npm ci                       # zero dependencies: installs offline
npm run preflight            # exit 1 — DB_URL is not set
env-doctor onboard .         # install → scan → repair → re-scan → time to green
npm start                    # orders-api listening on :3000
```
