export type Severity = "error" | "warning" | "info";

export interface Diagnosis {
  id: string;
  category: "dependency" | "version" | "env" | "runtime";
  severity: Severity;
  title: string;
  message: string;
  file?: string;
  line?: number;
  autoFixable: boolean;
  fixDescription?: string;
  fixed?: boolean;
  /** Internal metadata used by fixers; never required by report consumers. */
  details?: Record<string, string>;
}

export interface ScanResult {
  diagnoses: Diagnosis[];
  scannedAt: string;
  targetDir: string;
}

export interface FixResult {
  success: boolean;
  message: string;
}
