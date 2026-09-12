/**
 * Minimal `.env` loader — the same thing dotenv does, in 15 lines, so this
 * fixture has zero dependencies. Real values win over file values.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv(file = ".env") {
  const location = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", file);
  let source;
  try {
    source = readFileSync(location, "utf8");
  } catch {
    return;
  }
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
