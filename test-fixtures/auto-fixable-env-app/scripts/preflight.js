#!/usr/bin/env node
/**
 * Minimal startup check for the demo app: every variable the app reads must be
 * present. This is the reproduction command Env Doctor runs before and after each
 * repair, so "fixed" means "this file exits 0 now".
 */

import { loadEnv } from "./load-env.js";

loadEnv();

const required = ["API_URL", "API_TOKEN", "LOG_LEVEL"];
const missing = required.filter(key => !process.env[key] && !process.env[key === "API_URL" ? "API_BASE_URL" : key]);

if (missing.length > 0) {
  for (const key of missing) console.log(`FAIL[env.missing] ${key} is not set`);
  console.log(`preflight: ${missing.length} unset variable(s)`);
  process.exitCode = 1;
} else {
  console.log("OK[app.ready] all required configuration is present");
}
