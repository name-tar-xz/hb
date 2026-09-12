import { promises as fs } from "node:fs";
import path from "node:path";

const BACKUP_DIR_NAME = ".env-doctor-backups";

export interface BackupEntry {
  filePath: string;
  content: string | null;
  timestamp: number;
}

let backupStore: BackupEntry[] = [];

export function getBackupDir(targetDir: string): string {
  return path.join(targetDir, BACKUP_DIR_NAME);
}

export async function createBackup(targetDir: string, filePath: string): Promise<void> {
  const fullPath = path.join(targetDir, filePath);
  const backupDir = getBackupDir(targetDir);
  
  let content: string | null = null;
  try {
    content = await fs.readFile(fullPath, "utf8");
  } catch {
    content = null;
  }

  backupStore.push({ filePath, content, timestamp: Date.now() });
  
  await fs.mkdir(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, filePath.replaceAll("/", "_") + ".bak");
  await fs.writeFile(backupFile, content ?? "");
}

/**
 * Records a checkpoint in the backup journal. `revertTo(mark)` then restores exactly
 * the files written after it, so one repair can be taken back without disturbing an
 * earlier repair that verification already proved.
 */
export function markBackups(): number {
  return backupStore.length;
}

/** Restores every file backed up after `mark` and drops those entries from the journal. */
export async function revertTo(targetDir: string, mark: number): Promise<{ success: boolean; message: string; restored: string[] }> {
  const scoped = backupStore.slice(mark);
  if (!scoped.length) return { success: false, message: "Nothing to revert for this repair.", restored: [] };

  const restored: string[] = [];
  // Walk backwards so the earliest backup of a file wins.
  for (const entry of [...scoped].reverse()) {
    const fullPath = path.join(targetDir, entry.filePath);
    try {
      if (entry.content === null) {
        await fs.rm(fullPath, { force: true });
        restored.push(`${entry.filePath} (deleted)`);
      } else {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, entry.content);
        restored.push(entry.filePath);
      }
    } catch {
      /* report nothing restored for this file */
    }
  }

  backupStore = backupStore.slice(0, mark);
  return {
    success: true,
    restored,
    message: `Reverted ${restored.length} file${restored.length === 1 ? "" : "s"} for this repair: ${[...new Set(restored)].join(", ")}`,
  };
}

export async function revertAll(targetDir: string): Promise<{ success: boolean; message: string; restored: string[] }> {
  const backupDir = getBackupDir(targetDir);
  const restored: string[] = [];
  
  for (const entry of backupStore) {
    const fullPath = path.join(targetDir, entry.filePath);
    if (entry.content === null) {
      try {
        await fs.unlink(fullPath);
        restored.push(entry.filePath + " (deleted)");
      } catch {
      }
    } else {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, entry.content);
      restored.push(entry.filePath);
    }
  }
  
  try {
    await fs.rm(backupDir, { recursive: true, force: true });
  } catch {
  }
  
  const count = restored.length;
  backupStore = [];
  
  return { 
    success: true, 
    message: count > 0 ? `Reverted ${count} file${count === 1 ? "" : "s"}` : "No changes to revert", 
    restored 
  };
}

export function hasBackups(): boolean {
  return backupStore.length > 0;
}

export function clearBackups(): void {
  backupStore = [];
}

export function getBackupCount(): number {
  return backupStore.length;
}