import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixDiagnosis } from "../fixers/index.js";
import { scanEnv } from "../scanners/env.js";
test("automatically fixes missing and mismatched environment variables", async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "env-doctor-autofix-"));
    try {
        await fs.writeFile(path.join(targetDir, ".env.example"), "DB_URL=postgres://localhost/app\nAPI_KEY=example-key\n");
        await fs.writeFile(path.join(targetDir, ".env"), "DB_URL=postgres://localhost/app\n");
        await fs.writeFile(path.join(targetDir, "app.js"), "const database = process.env.DATABASE_URL;\n");
        const before = await scanEnv(targetDir);
        const mismatch = before.find(item => item.id.startsWith("env-mismatch:DATABASE_URL:"));
        const missing = before.find(item => item.id === "missing-env-var:API_KEY");
        assert.ok(mismatch, "the variable mismatch should be detected");
        assert.ok(missing, "the missing variable should be detected");
        assert.equal(mismatch.autoFixable, true, "the variable mismatch should be auto-fixable");
        assert.equal(missing.autoFixable, true, "the missing variable should be auto-fixable");
        assert.equal((await fixDiagnosis(mismatch, targetDir)).success, true);
        assert.equal((await fixDiagnosis(missing, targetDir)).success, true);
        const env = await fs.readFile(path.join(targetDir, ".env"), "utf8");
        assert.match(env, /^DATABASE_URL=postgres:\/\/localhost\/app$/m);
        assert.match(env, /^API_KEY=example-key$/m);
        const after = await scanEnv(targetDir);
        assert.equal(after.some(item => item.id.startsWith("env-mismatch:DATABASE_URL:")), false);
        assert.equal(after.some(item => item.id === "missing-env-var:API_KEY"), false);
    }
    finally {
        await fs.rm(targetDir, { recursive: true, force: true });
    }
});
