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