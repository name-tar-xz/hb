#!/usr/bin/env node
/**
 * Startup preflight — the same check the container entrypoint runs before the
 * service accepts traffic. It exercises the application's own configuration module,
 * not a copy of it, so a green preflight means the app can boot.
 */
import { loadEnv } from "./load-env.js";

loadEnv();

// Imported after the environment is loaded: src/config.js reads process.env at
// module evaluation time, exactly like the real service does.
const { describe } = await import("../src/config.js");
const { assertSafeConnection } = await import("../src/db.js");

const problems = [];

try {
  const connection = assertSafeConnection();
  console.log(`OK[db.connection] ${connection.host}/${connection.database} (sslmode=${connection.sslmode})`);
} catch (error) {
  problems.push({ code: "env.db_url", message: error.message });
}

const state = describe();
console.log(`INFO[app.config] db=${state.hasDatabaseUrl ? "set" : "unset"} analytics=${state.hasAnalyticsKey ? "set" : "unset"} log=${state.logLevel}`);
if (!state.hasAnalyticsKey) {
  console.log("WARN[env.analytics] ANALYTICS_KEY is not set — analytics events will be dropped");
}

if (problems.length > 0) {
  for (const problem of problems) console.log(`FAIL[${problem.code}] ${problem.message}`);
  console.log(`preflight: ${problems.length} blocking configuration problem(s)`);
  process.exitCode = 1;
} else {
  console.log("OK[app.ready] configuration validated — orders-api is ready to start");
}
