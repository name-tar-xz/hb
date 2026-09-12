import express from "express";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import open from "open";
import { fixDiagnosis } from "./fixers/index.js";
import { scanAll } from "./scanners/index.js";
const here = path.dirname(fileURLToPath(import.meta.url));
export async function startServer(targetDir) {
    const app = express();
    let activeTargetDir = targetDir;
    let uploadedTargetDir;
    const uploads = multer({ storage: multer.memoryStorage(), limits: { files: 10000, fileSize: 50 * 1024 * 1024 } });
    app.use(express.json());
    app.use(express.static(path.resolve(here, "../ui")));
    const scan = () => scanAll(activeTargetDir);
    app.get("/api/scan", async (_req, res) => res.json(await scan()));
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
            activeTargetDir = folder;
            const result = await scan();
            res.json({ ...result, displayName: hasSharedRoot ? rootName : "Dropped project", uploaded: true });
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
        res.status(outcome.success ? 200 : 400).json({ ...diagnosis, fixed: outcome.success, fixMessage: outcome.message });
    });
    app.post("/api/fix-all", async (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        let result = await scan();
        for (const diagnosis of result.diagnoses.filter(item => item.autoFixable)) {
            send("start", { id: diagnosis.id, title: diagnosis.title });
            const outcome = await fixDiagnosis(diagnosis, activeTargetDir, line => send("progress", { id: diagnosis.id, line: line.trim() }));
            send("fixed", { id: diagnosis.id, success: outcome.success, message: outcome.message });
            result = await scan();
        }
        send("complete", await scan());
        res.end();
    });
    const server = createServer(app);
    const port = await new Promise((resolve, reject) => {
        const tryPort = (candidate) => {
            const onError = (error) => error.code === "EADDRINUSE" ? tryPort(candidate + 1) : reject(error);
            server.once("error", onError);
            server.listen(candidate, "127.0.0.1", () => { server.off("error", onError); resolve(candidate); });
        };
        tryPort(4200);
    });
    const url = `http://localhost:${port}`;
    console.log(`Env Doctor UI is ready at ${url}`);
    await open(url).catch(() => console.log("Open the address above in a browser."));
}
