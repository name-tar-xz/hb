/**
 * Application configuration.
 *
 * This file reads DB_URL. The container image injects DB_URL (see
 * deploy/platform.yaml), and this is the line the orders service has used in
 * production for two years.
 */
export const config = {
  databaseUrl: process.env.DB_URL,
  analyticsKey: process.env.ANALYTICS_KEY,
  logLevel: process.env.LOG_LEVEL ?? "info",
};

export function describe() {
  return {
    service: "orders-api",
    hasDatabaseUrl: Boolean(config.databaseUrl),
    hasAnalyticsKey: Boolean(config.analyticsKey),
    logLevel: config.logLevel,
  };
}
