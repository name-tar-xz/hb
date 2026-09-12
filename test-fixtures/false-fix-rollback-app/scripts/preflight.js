#!/usr/bin/env node
/**
 * This service looks like it has an environment problem — and it does have one
 * (`DB_URL` vs `DATABASE_URL`, same as the landmine fixture) — but the environment
 * problem is *not* why startup fails.
 *
 * The real failure is a missing local config file. Env Doctor's repair loop applies
 * the env fix, re-runs this file, sees an identical failure, and hands the change back.
 */

import { readFileSync } from "node:fs";
import { loadEnv } from "./load-env.js";

loadEnv();

// The environment is loaded and correct-ish — startup still dies here, before any
// of it is used, because the local config file was never committed.
const config = JSON.parse(readFileSync(new URL("./config/local.json", import.meta.url), "utf8"));

const url = process.env.DB_URL;
if (!url) {
  console.log("FAIL[env.db_url] DB_URL is not set — refusing to start");
  process.exitCode = 1;
} else {
  console.log(`OK[app.ready] connected using ${config.serviceName}`);
}
