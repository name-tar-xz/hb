#!/usr/bin/env node
/** Service entrypoint: validate configuration, then accept traffic. */
import { createServer } from "node:http";
import { describe } from "./config.js";
import { assertSafeConnection } from "./db.js";

const connection = assertSafeConnection();
const port = Number(process.env.PORT ?? 3000);

const server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ service: "orders-api", database: connection.database }));
});

server.listen(port, () => {
  console.log(`orders-api listening on :${port}`);
  console.log(`  database ${connection.host}/${connection.database} (sslmode=${connection.sslmode})`);
  console.log(`  analytics ${describe().hasAnalyticsKey ? "enabled" : "disabled"} · log level ${describe().logLevel}`);
});
