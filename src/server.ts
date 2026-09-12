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
import { revertAll, hasBackups, clearBackups } from "./fixers/backup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ZIP_SKIPPED_DIRECTORIES = new Set([".git", ".env-doctor-backups", "coverage", "dist", "node_modules"]);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(contents: Buffer): number {
  let value = 0xffffffff;
  for (const byte of contents) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}
function dosDate(date: Date): number { return (Math.max(date.getFullYear(), 1980) - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate(); }
function dosTime(date: Date): number { return date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2); }

async function zipProject(targetDir: string): Promise<Buffer> {
  const files: Array<{ path: string; contents: Buffer; modified: Date }> = [];
  async function visit(relative = ""): Promise<void> {
    for (const entry of await fs.readdir(path.join(targetDir, relative), { withFileTypes: true })) {
      if (entry.isDirectory() && ZIP_SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const fullPath = path.join(targetDir, child);
        const metadata = await fs.stat(fullPath);
        files.push({ path: child.replaceAll(path.sep, "/"), contents: await fs.readFile(fullPath), modified: metadata.mtime });
      }
    }
  }
  await visit();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const checksum = crc32(file.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime(file.modified), 10); local.writeUInt16LE(dosDate(file.modified), 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(file.contents.length, 18); local.writeUInt32LE(file.contents.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime(file.modified), 12); central.writeUInt16LE(dosDate(file.modified), 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(file.contents.length, 20); central.writeUInt32LE(file.contents.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 36); central.writeUInt32LE(offset, 42);
    localParts.push(local, name, file.contents); centralParts.push(central, name);
    offset += local.length + name.length + file.contents.length;
  }
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function startServer(targetDir: string): Promise<void> {
  const app = express();
  let activeTargetDir = targetDir;
  let uploadedTargetDir: string | undefined;
  let uploadedDisplayName: string | undefined;
  let hasAppliedFixes = false;
  const uploads = multer({ storage: multer.memoryStorage(), limits: { files: 10000, fileSize: 50 * 1024 * 1024 } });
  app.use(express.json());
  app.use(express.static(path.resolve(here, "../ui")));
  const scan = () => scanAll(activeTargetDir);
  app.get("/api/scan", async (_req, res) => {
    res.json({ ...await scan(), uploaded: Boolean(uploadedTargetDir), displayName: uploadedDisplayName, canRevert: hasBackups(), canDownload: Boolean(uploadedTargetDir && hasAppliedFixes) });
  });
  app.post("/api/project", uploads.array("files"), async (req, res) => {
    const files = req.files as Express.Multer.File[];
    const submittedPaths: unknown[] = Array.isArray(req.body.paths) ? req.body.paths : req.body.paths ? [req.body.paths] : [];
    const relativePaths: string[][] = submittedPaths.map((item: unknown) => String(item).replaceAll("\\", "/").split("/").filter(Boolean));
    if (!files?.length || files.length !== relativePaths.length) return res.status(400).json({ error: "No readable project files were supplied." });
    const rootName = relativePaths[0]?.[0];
    const hasSharedRoot = Boolean(rootName) && relativePaths.every((parts: string[]) => parts.length > 1 && parts[0] === rootName);
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "env-doctor-project-"));
    try {
      for (let index = 0; index < files.length; index++) {
        const pieces = hasSharedRoot ? relativePaths[index].slice(1) : relativePaths[index];
        if (!pieces.length || pieces.some((part: string) => !part || part === "." || part === ".." || path.isAbsolute(part))) throw new Error("The dropped folder contains an unsafe path.");
        const output = path.join(folder, ...pieces);
        if (!path.resolve(output).startsWith(path.resolve(folder) + path.sep)) throw new Error("The dropped folder contains an unsafe path.");
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, files[index].buffer);
      }
      if (uploadedTargetDir) await fs.rm(uploadedTargetDir, { recursive: true, force: true });
      uploadedTargetDir = folder;
      uploadedDisplayName = hasSharedRoot ? rootName : "Dropped project";
      activeTargetDir = folder;
      hasAppliedFixes = false;
      clearBackups();
      const result = await scan();
      res.json({ ...result, displayName: uploadedDisplayName, uploaded: true, canRevert: false, canDownload: false });
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true });
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not prepare the dropped project." });
    }
  });
  app.post("/api/fix", async (req, res) => {
    const result = await scan();
    const diagnosis = result.diagnoses.find(item => item.id === req.body?.id);
    if (!diagnosis) return res.status(404).json({ error: "Diagnosis not found. Scan again and retry." });
    const outcome = await fixDiagnosis(diagnosis, activeTargetDir);
    if (outcome.success) hasAppliedFixes = true;
    res.status(outcome.success ? 200 : 400).json({ ...diagnosis, fixed: outcome.success, fixMessage: outcome.message });
  });
  app.post("/api/fix-all", async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    const result = await scan();
    for (const diagnosis of result.diagnoses.filter(item => item.autoFixable)) {
      send("start", { id: diagnosis.id, title: diagnosis.title });
      const outcome = await fixDiagnosis(diagnosis, activeTargetDir, line => send("progress", { id: diagnosis.id, line: line.trim() }));
      if (outcome.success) hasAppliedFixes = true;
      send("fixed", { id: diagnosis.id, success: outcome.success, message: outcome.message });
    }
    send("complete", { ...await scan(), uploaded: Boolean(uploadedTargetDir), displayName: uploadedDisplayName, canRevert: hasBackups(), canDownload: Boolean(uploadedTargetDir && hasAppliedFixes) });
    res.end();
  });
  app.post("/api/revert", async (_req, res) => {
    if (!hasBackups()) return res.json({ success: false, message: "No changes to revert" });
    const result = await revertAll(activeTargetDir);
    clearBackups();
    hasAppliedFixes = false;
    res.json({ ...await scan(), uploaded: Boolean(uploadedTargetDir), displayName: uploadedDisplayName, canRevert: false, canDownload: false, restored: result.restored });
  });
  app.get("/api/project/download", async (_req, res) => {
    if (!uploadedTargetDir || !hasAppliedFixes) return res.status(400).json({ error: "Fix a dropped project before downloading it." });
    const archive = await zipProject(activeTargetDir);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="env-doctor-fixed-project.zip"');
    res.send(archive);
  });
  const server = createServer(app);
  const port = await new Promise<number>((resolve, reject) => {
    const tryPort = (candidate: number) => {
      const onError = (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? tryPort(candidate + 1) : reject(error);
      server.once("error", onError);
      server.listen(candidate, "127.0.0.1", () => { server.off("error", onError); resolve(candidate); });
    };
    tryPort(4200);
  });
  const url = `http://localhost:${port}`;
  console.log(`Env Doctor UI is ready at ${url}`);
  await open(url).catch(() => console.log("Open the address above in a browser."));
}
