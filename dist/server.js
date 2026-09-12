import express from "express";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import open from "open";
import { runVerifiedRepair } from "./commands/verified-repair.js";
import { loadPolicy } from "./config.js";
import { fixDiagnosis } from "./fixers/index.js";
import { scanAll } from "./scanners/index.js";
import { revertAll, hasBackups, clearBackups } from "./fixers/backup.js";
const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Directories that must never appear in a downloaded copy.
 *
 * `.envdoctor-backups` (the transaction journal, written by verified repairs) holds the
 * *previous* contents of every file a repair touched — including `.env`. Shipping that
 * inside a "fixed copy" would hand back the pre-repair secrets, so it is excluded along
 * with the other backup store and the usual build/VCS noise.
 */
const ZIP_SKIPPED_DIRECTORIES = new Set([
    ".git", "node_modules", "dist", "coverage", "out", "build",
    ".envdoctor-backups", ".env-doctor-backups", ".envdoctor-work",
]);
/** Individual files larger than this are skipped rather than buffered in memory. */
const ZIP_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Stop adding files once the archive reaches this size. */
const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
});
function crc32(contents) {
    let value = 0xffffffff;
    for (const byte of contents)
        value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
    return (value ^ 0xffffffff) >>> 0;
}
function dosDate(date) { return (Math.max(date.getFullYear(), 1980) - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate(); }
function dosTime(date) { return date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2); }
async function zipProject(targetDir) {
    const files = [];
    const skipped = [];
    let total = 0;
    async function visit(relative = "") {
        let entries;
        try {
            entries = await fs.readdir(path.join(targetDir, relative), { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && ZIP_SKIPPED_DIRECTORIES.has(entry.name))
                continue;
            const child = relative ? path.join(relative, entry.name) : entry.name;
            if (entry.isDirectory()) {
                await visit(child);
                continue;
            }
            if (!entry.isFile())
                continue;
            const fullPath = path.join(targetDir, child);
            const relativePath = child.replaceAll(path.sep, "/");
            let metadata;
            try {
                metadata = await fs.stat(fullPath);
            }
            catch {
                continue;
            }
            if (metadata.size > ZIP_MAX_FILE_BYTES || total + metadata.size > ZIP_MAX_TOTAL_BYTES) {
                skipped.push(relativePath);
                continue;
            }
            try {
                const contents = await fs.readFile(fullPath);
                total += contents.length;
                files.push({ path: relativePath, contents, modified: metadata.mtime });
            }
            catch {
                skipped.push(relativePath);
            }
        }
    }
    await visit();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.path, "utf8");
        const checksum = crc32(file.contents);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(dosTime(file.modified), 10);
        local.writeUInt16LE(dosDate(file.modified), 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(file.contents.length, 18);
        local.writeUInt32LE(file.contents.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(dosTime(file.modified), 12);
        central.writeUInt16LE(dosDate(file.modified), 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(file.contents.length, 20);
        central.writeUInt32LE(file.contents.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt32LE(0, 36);
        central.writeUInt32LE(offset, 42);
        localParts.push(local, name, file.contents);
        centralParts.push(central, name);
        offset += local.length + name.length + file.contents.length;
    }
    const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return { archive: Buffer.concat([...localParts, ...centralParts, end]), fileCount: files.length, skipped };
}
/** Exported for tests: a downloaded copy must never contain the repair journal. */
export { zipProject };
export async function startServer(targetDir, options = {}) {
    const app = express();
    let activeTargetDir = targetDir;
    let uploadedTargetDir;
    let uploadedDisplayName;
    let hasAppliedFixes = false;
    /** The project the UI is acting on: a dropped folder, or the directory the CLI served. */
    const displayName = () => (uploadedTargetDir ? (uploadedDisplayName ?? "Dropped project") : path.basename(activeTargetDir));
    /** Downloadable whenever a repair was applied to the active project — uploaded or served locally. */
    const canDownload = () => Boolean(hasAppliedFixes);
    const projectName = () => (uploadedDisplayName && uploadedDisplayName !== "Dropped project" ? uploadedDisplayName : path.basename(activeTargetDir));
    /** One shape for every scan payload, so the buttons can never disagree with each other. */
    const scanPayload = async () => ({
        ...await scan(),
        uploaded: Boolean(uploadedTargetDir),
        displayName: displayName(),
        canRevert: hasBackups(),
        canDownload: canDownload(),
    });
    const uploads = multer({ storage: multer.memoryStorage(), limits: { files: 10000, fileSize: 50 * 1024 * 1024 } });
    app.use(express.json());
    app.use(express.static(path.resolve(here, "../ui")));
    const scan = () => scanAll(activeTargetDir);
    app.get("/api/scan", async (_req, res) => {
        res.json(await scanPayload());
    });
    app.post("/api/project", uploads.array("files"), async (req, res) => {
        const files = req.files;
        const submittedPaths = Array.isArray(req.body.paths) ? req.body.paths : req.body.paths ? [req.body.paths] : [];
        const relativePaths = submittedPaths.map((item) => String(item).replaceAll("\\", "/").split("/").filter(Boolean));
        if (!files?.length || files.length !== relativePaths.length)
            return res.status(400).json({ error: "No readable project files were supplied." });
        const rootName = relativePaths[0]?.[0];
        const hasSharedRoot = Boolean(rootName) && relativePaths.every((parts) => parts.length > 1 && parts[0] === rootName);
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), "env-doctor-project-"));
        try {
            for (let index = 0; index < files.length; index++) {
                const pieces = hasSharedRoot ? relativePaths[index].slice(1) : relativePaths[index];
                if (!pieces.length || pieces.some((part) => !part || part === "." || part === ".." || path.isAbsolute(part)))
                    throw new Error("The dropped folder contains an unsafe path.");
                const output = path.join(folder, ...pieces);
                if (!path.resolve(output).startsWith(path.resolve(folder) + path.sep))
                    throw new Error("The dropped folder contains an unsafe path.");
                await fs.mkdir(path.dirname(output), { recursive: true });
                await fs.writeFile(output, files[index].buffer);
            }
            if (uploadedTargetDir)
                await fs.rm(uploadedTargetDir, { recursive: true, force: true });
            uploadedTargetDir = folder;
            uploadedDisplayName = hasSharedRoot ? rootName : "Dropped project";
            activeTargetDir = folder;
            hasAppliedFixes = false;
            clearBackups();
            const result = await scan();
            res.json({ ...result, displayName: uploadedDisplayName, uploaded: true, canRevert: false, canDownload: false });
        }
        catch (error) {
            await fs.rm(folder, { recursive: true, force: true });
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not prepare the dropped project." });
        }
    });
    app.post("/api/fix", async (req, res) => {
        const result = await scan();
        const diagnosis = result.diagnoses.find(item => item.id === req.body?.id);
        if (!diagnosis)
            return res.status(404).json({ error: "Diagnosis not found. Scan again and retry." });
        const outcome = await fixDiagnosis(diagnosis, activeTargetDir);
        if (outcome.success)
            hasAppliedFixes = true;
        res.status(outcome.success ? 200 : 400).json({ ...diagnosis, fixed: outcome.success, fixMessage: outcome.message });
    });
    app.post("/api/fix-all", async (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        const result = await scan();
        for (const diagnosis of result.diagnoses.filter(item => item.autoFixable)) {
            send("start", { id: diagnosis.id, title: diagnosis.title });
            const outcome = await fixDiagnosis(diagnosis, activeTargetDir, line => send("progress", { id: diagnosis.id, line: line.trim() }));
            if (outcome.success)
                hasAppliedFixes = true;
            send("fixed", { id: diagnosis.id, success: outcome.success, message: outcome.message });
        }
        send("complete", await scanPayload());
        res.end();
    });
    app.post("/api/onboard", async (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        try {
            const policy = await loadPolicy(activeTargetDir);
            const outcome = await runVerifiedRepair({
                targetDir: activeTargetDir,
                policy,
                repairClass: "env",
                log: line => send("progress", { line }),
            });
            if (outcome.repairs.some(repair => !repair.rolledBack))
                hasAppliedFixes = true;
            send("complete", {
                reproMode: outcome.reproMode,
                projectRepro: outcome.projectRepro
                    ? {
                        command: outcome.projectRepro.spec.command,
                        before: { exitCode: outcome.projectRepro.before.exitCode, stdoutHash: outcome.projectRepro.before.stdoutHash, signature: outcome.projectRepro.before.signature },
                        after: outcome.projectRepro.after
                            ? { exitCode: outcome.projectRepro.after.exitCode, stdoutHash: outcome.projectRepro.after.stdoutHash, signature: outcome.projectRepro.after.signature }
                            : null,
                    }
                    : null,
                repairs: outcome.repairs,
                escalations: outcome.escalations,
                summary: outcome.summary,
                verified: outcome.verified,
                receipt: outcome.receipt
                    ? {
                        id: outcome.receipt.id,
                        verdict: outcome.receipt.verdict,
                        summary: outcome.receipt.summary,
                        networkCalls: outcome.receipt.networkCalls,
                        guarantees: outcome.receipt.guarantees,
                    }
                    : undefined,
                scan: await scanPayload(),
            });
        }
        catch (error) {
            send("failure", { message: error instanceof Error ? error.message : "Verified repair failed." });
        }
        res.end();
    });
    app.post("/api/revert", async (_req, res) => {
        if (!hasBackups())
            return res.json({ success: false, message: "No changes to revert" });
        const result = await revertAll(activeTargetDir);
        clearBackups();
        hasAppliedFixes = false;
        res.json({ ...await scanPayload(), canRevert: false, canDownload: false, restored: result.restored });
    });
    app.get("/api/project/download", async (_req, res) => {
        if (!hasAppliedFixes) {
            return res.status(409).json({ error: "No repaired copy is available yet — run a repair first (changes are only included once they are applied)." });
        }
        let result;
        try {
            result = await zipProject(activeTargetDir);
        }
        catch (error) {
            return res.status(500).json({ error: `Could not build the archive: ${error instanceof Error ? error.message : "unknown error"}` });
        }
        if (result.fileCount === 0)
            return res.status(409).json({ error: "There were no files to package." });
        const safeName = projectName().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${safeName}-fixed.zip"`);
        res.setHeader("X-Env-Doctor-Files", String(result.fileCount));
        res.setHeader("X-Env-Doctor-Skipped", String(result.skipped.length));
        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Env-Doctor-Files, X-Env-Doctor-Skipped");
        res.setHeader("Content-Length", String(result.archive.length));
        res.end(result.archive);
    });
    const server = createServer(app);
    // Bind to all interfaces when asked (containers, previews); localhost otherwise.
    const HOST = options.host ?? process.env.ENV_DOCTOR_HOST ?? "127.0.0.1";
    const requested = options.port ?? (process.env.PORT ? Number(process.env.PORT) : undefined) ?? 4200;
    const port = await new Promise((resolve, reject) => {
        const tryPort = (candidate) => {
            const onError = (error) => {
                // Port 0 means "any free port": never walk upward from it.
                if (error.code === "EADDRINUSE" && candidate !== 0)
                    tryPort(candidate + 1);
                else
                    reject(error);
            };
            server.once("error", onError);
            server.listen(candidate, HOST, () => {
                server.off("error", onError);
                const address = server.address();
                resolve(typeof address === "object" && address ? address.port : candidate);
            });
        };
        tryPort(requested);
    });
    const url = `http://localhost:${port}`;
    console.log(`Env Doctor UI is ready at ${url}`);
    const shouldOpen = options.open ?? !process.env.ENV_DOCTOR_NO_OPEN;
    if (shouldOpen)
        await open(url).catch(() => console.log("Open the address above in a browser."));
    return { url, port, close: () => new Promise(resolve => server.close(() => resolve())) };
}
