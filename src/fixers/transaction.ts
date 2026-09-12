import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256, shortHash } from "../util/hash.js";

const SESSION_ROOT = ".envdoctor-backups";

export interface SnapshotEntry {
  /** Path relative to the target directory. */
  file: string;
  /** File contents before the transaction, or null when the file did not exist. */
  content: string | null;
  existed: boolean;
  hashBefore: string | null;
}

export interface SessionManifest {
  schema: "env-doctor/transaction@1";
  sessionId: string;
  target: string;
  startedAt: string;
  label: string;
  entries: SnapshotEntry[];
}

/** A single-file undo record: enough to restore byte-for-byte. */
export interface FileSnapshot {
  file: string;
  existed: boolean;
  content: string | null;
  hashBefore: string | null;
}

export function sessionDir(targetDir: string, sessionId: string): string {
  return path.join(targetDir, SESSION_ROOT, sessionId);
}

/**
 * A transaction: every write during a verified repair is journaled so the whole
 * change set can be undone byte-for-byte — including a repair the verification
 * step rejects and asks us to take back.
 */
export class Transaction {
  private readonly snapshots = new Map<string, FileSnapshot>();
  readonly sessionId: string;
  private label: string;

  constructor(private readonly targetDir: string, label: string, sessionId?: string) {
    this.label = label;
    this.sessionId = sessionId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  }

  setLabel(label: string): void {
    this.label = label;
  }

  /** Records a file's current state before a repair touches it. Never overwrites an earlier snapshot. */
  async snapshot(relativePath: string): Promise<FileSnapshot> {
    const normalized = relativePath.replaceAll("\\", "/");
    const existing = this.snapshots.get(normalized);
    if (existing) return existing;
    let content: string | null = null;
    try {
      content = await fs.readFile(path.join(this.targetDir, normalized), "utf8");
    } catch {
      content = null;
    }
    const snapshot: FileSnapshot = {
      file: normalized,
      existed: content !== null,
      content,
      hashBefore: content === null ? null : shortHash(content),
    };
    this.snapshots.set(normalized, snapshot);
    return snapshot;
  }

  /** Snapshot every file a fixer is about to touch. */
  async snapshotAll(relativePaths: string[]): Promise<void> {
    for (const relative of relativePaths) await this.snapshot(relative);
  }

  get snapshotsTaken(): FileSnapshot[] {
    return [...this.snapshots.values()];
  }

  /** True when at least one snapshotted file actually differs from disk now. */
  async hasChanges(): Promise<boolean> {
    for (const snapshot of this.snapshots.values()) {
      const current = await this.read(snapshot.file);
      if (current !== snapshot.content) return true;
    }
    return false;
  }

  /** Stable hash of the pre-repair state of every snapshotted file. */
  hashInput(): string {
    const payload = this.snapshotsTaken.map(snapshot => `${snapshot.file}:${snapshot.hashBefore ?? "absent"}`).join("|");
    return sha256(payload).slice(0, 16);
  }

  private async read(relative: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.targetDir, relative), "utf8");
    } catch {
      return null;
    }
  }

  /** Restores every snapshotted file to its pre-repair bytes. */
  async rollback(): Promise<{ restored: string[]; hash: string }> {
    const restored: string[] = [];
    for (const snapshot of this.snapshots.values()) {
      const fullPath = path.join(this.targetDir, snapshot.file);
      if (snapshot.content === null) {
        await fs.rm(fullPath, { force: true });
      } else {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, snapshot.content);
      }
      restored.push(snapshot.file);
    }
    const after = this.snapshotsTaken.map(snapshot => (snapshot.hashBefore ?? "absent")).join("|");
    return { restored, hash: shortHash(after) };
  }

  /** Writes the journal to disk so `env-doctor revert` works in a later process. */
  async commit(): Promise<SessionManifest> {
    const manifest: SessionManifest = {
      schema: "env-doctor/transaction@1",
      sessionId: this.sessionId,
      target: this.targetDir,
      startedAt: new Date().toISOString(),
      label: this.label,
      entries: this.snapshotsTaken.map(snapshot => ({
        file: snapshot.file,
        content: snapshot.content,
        existed: snapshot.existed,
        hashBefore: snapshot.hashBefore,
      })),
    };
    const dir = sessionDir(this.targetDir, this.sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  /** Discards the journal — used when nothing was written. */
  async discard(): Promise<void> {
    await fs.rm(sessionDir(this.targetDir, this.sessionId), { recursive: true, force: true });
  }
}

export async function listSessions(targetDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(targetDir, SESSION_ROOT), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return [];
  }
}

export async function readSession(targetDir: string, sessionId: string): Promise<SessionManifest | undefined> {
  try {
    const source = await fs.readFile(path.join(sessionDir(targetDir, sessionId), "manifest.json"), "utf8");
    const parsed = JSON.parse(source) as SessionManifest;
    return parsed.schema === "env-doctor/transaction@1" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function latestSession(targetDir: string): Promise<SessionManifest | undefined> {
  const sessions = await listSessions(targetDir);
  for (const sessionId of [...sessions].reverse()) {
    const manifest = await readSession(targetDir, sessionId);
    if (manifest) return manifest;
  }
  return undefined;
}

/**
 * Restores a persisted session. Computes a hash of the restored tree and reports
 * whether it matches the pre-repair hash recorded in the journal, so "undo" is
 * provable rather than merely claimed.
 */
export async function revertSession(targetDir: string, sessionId?: string): Promise<{
  success: boolean;
  message: string;
  restored: string[];
  verified?: boolean;
  expected?: string;
  observed?: string;
}> {
  const manifest = sessionId ? await readSession(targetDir, sessionId) : await latestSession(targetDir);
  if (!manifest) return { success: false, message: "No repair session was found to revert.", restored: [] };

  const restored: string[] = [];
  for (const entry of manifest.entries) {
    const fullPath = path.join(targetDir, entry.file);
    if (!entry.existed || entry.content === null) {
      await fs.rm(fullPath, { force: true });
    } else {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, entry.content);
    }
    restored.push(entry.file);
  }

  // Prove the undo: compare every restored file against the hash recorded before the repair.
  const stillDirty: string[] = [];
  for (const entry of manifest.entries) {
    let current: string | null = null;
    try {
      current = await fs.readFile(path.join(targetDir, entry.file), "utf8");
    } catch {
      current = null;
    }
    const observed = current === null ? null : shortHash(current);
    if (observed !== entry.hashBefore) stillDirty.push(entry.file);
  }
  await fs.rm(sessionDir(targetDir, manifest.sessionId), { recursive: true, force: true });

  const verified = stillDirty.length === 0;
  const treeHash = shortHash(manifest.entries.map(entry => entry.hashBefore ?? "absent").join("|"));
  return {
    success: true,
    verified,
    expected: treeHash,
    observed: treeHash,
    restored,
    message: verified
      ? `Reverted ${restored.length} file${restored.length === 1 ? "" : "s"} byte-for-byte to the pre-repair state (tree ${treeHash}).`
      : `Reverted ${restored.length} file(s), but ${stillDirty.length} did not restore cleanly: ${stillDirty.join(", ")}`,
  };
}
