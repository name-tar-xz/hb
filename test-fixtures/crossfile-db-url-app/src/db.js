import { config } from "./config.js";

/** Connection descriptor built from the configured URL. No driver, no network. */
export function describeConnection() {
  if (!config.databaseUrl) {
    throw new Error("DB_URL is not set — the orders database cannot be reached");
  }
  const url = new URL(config.databaseUrl);
  return {
    protocol: url.protocol.replace(":", ""),
    host: url.host,
    database: url.pathname.replace(/^\//, ""),
    sslmode: url.searchParams.get("sslmode"),
  };
}

export function assertSafeConnection() {
  const connection = describeConnection();
  if (connection.protocol !== "postgres") {
    throw new Error(`DB_URL must be a postgres:// URL, got ${connection.protocol}://`);
  }
  if (connection.sslmode !== "require") {
    throw new Error("DB_URL must include ?sslmode=require — the managed database rejects plaintext connections");
  }
  return connection;
}
