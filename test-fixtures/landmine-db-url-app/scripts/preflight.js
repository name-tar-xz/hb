#!/usr/bin/env node
/**
 * Startup preflight for the API service.
 *
 * This is the check that runs in CI and in the container entrypoint. It validates
 * the configuration the service actually reads — which is where the landmine is:
 * this file reads `DB_URL`, while `.env.example` declares the same database as
 * `DATABASE_URL`. Nothing in either file looks wrong on its own.
 */

import { loadEnv } from "./load-env.js";

// The entrypoint loads .env exactly like the service does, so anything written
// into .env is observable here.
loadEnv();

const problems = [];

const url = process.env.DB_URL;

if (!url) {
  problems.push({ code: "env.db_url", message: "DB_URL is not set — refusing to start" });
} else {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    problems.push({ code: "env.db_url_format", message: `DB_URL is not a valid connection URL: ${url}` });
  }
  if (parsed) {
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      problems.push({ code: "env.db_url_scheme", message: `DB_URL must be a postgres:// URL, got ${parsed.protocol}//` });
    }
    if (parsed.searchParams.get("sslmode") !== "require") {
      problems.push({ code: "env.db_url_sslmode", message: "DB_URL must include ?sslmode=require — the managed database rejects plaintext connections" });
    }
  }
}

if (!process.env.ANALYTICS_KEY) {
  console.log("WARN[env.analytics] ANALYTICS_KEY is not set — analytics disabled");
}

if (problems.length > 0) {
  for (const problem of problems) console.log(`FAIL[${problem.code}] ${problem.message}`);
  console.log(`preflight: ${problems.length} blocking configuration problem(s)`);
  process.exitCode = 1;
} else {
  console.log("OK[app.ready] configuration validated — service is ready to start");
}
