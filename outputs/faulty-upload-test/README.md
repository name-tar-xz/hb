# Faulty upload test project

This folder is intentionally broken for testing Env Doctor's upload interface.

Expected scan results:

- Missing `lodash`
- React version mismatch (`17.0.2` installed, `^18.2.0` required)
- `DATABASE_URL` in code versus `DB_URL` in `.env`
- Node runtime mismatch with `.nvmrc`
