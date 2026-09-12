#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { fixDiagnosis } from "./fixers/index.js";
import { renderReport } from "./report/printer.js";
import { scanAll } from "./scanners/index.js";
import { startServer } from "./server.js";

const program = new Command();
program.name("env-doctor").description("Diagnose local development environment problems.")
  .argument("[path]", "directory to scan")
  .option("--fix", "apply safe fixes")
  .option("--dry-run", "show safe fixes without running them")
  .option("--ui", "open the local web interface")
  .option("--json", "print raw scan JSON")
  .action(async (input, options) => {
    if (!input && !options.ui) {
      console.error("error: missing required argument 'path'");
      process.exitCode = 1;
      return;
    }
    const targetDir = path.resolve(input ?? ".");
    if (options.ui) return startServer(targetDir);
    let result = await scanAll(targetDir);
    if (options.dryRun) {
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(renderReport(result));
        const fixable = result.diagnoses.filter(d => d.autoFixable);
        if (fixable.length) console.log(`\nDry run — no files were changed:\n${fixable.map(d => `• ${d.fixDescription}`).join("\n")}`);
      }
    } else if (options.fix) {
      for (const diagnosis of result.diagnoses.filter(d => d.autoFixable)) {
        if (!options.json) console.log(`\nFixing: ${diagnosis.title}`);
        const outcome = await fixDiagnosis(diagnosis, targetDir, line => { if (!options.json && line) process.stdout.write(`${line}\n`); });
        if (!options.json) console.log(outcome.success ? `✓ ${outcome.message}` : `✗ ${outcome.message}`);
      }
      result = await scanAll(targetDir);
      if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log(`\n${renderReport(result)}`);
    } else console.log(options.json ? JSON.stringify(result, null, 2) : renderReport(result));
    if (result.diagnoses.some(d => d.severity === "error")) process.exitCode = 1;
  });
program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
