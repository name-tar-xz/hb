# Env Doctor

Env Doctor is a local TypeScript tool that checks a codebase for missing or mismatched Node/Python packages, environment variable mistakes, and runtime-version conflicts. It can safely repair only unambiguous issues.

## Install and run

```sh
npm install
npm run build
npx env-doctor
```

Or run directly during development:

```sh
npm run dev -- test-fixtures/broken-node-app
```

Useful options: `--fix`, `--dry-run`, `--json`, and `--ui`. The UI scans the directory passed to the CLI and is served locally.

## Demo fixture

`test-fixtures/broken-node-app` intentionally includes a missing `lodash`, an outdated `react`, a `DATABASE_URL` / `DB_URL` environment mismatch, and an `.nvmrc` runtime mismatch. It is safe to scan. To demonstrate repair without changing the tracked fixture, copy it somewhere temporary first.
