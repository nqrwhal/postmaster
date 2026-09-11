#!/usr/bin/env node
import { mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve(process.env.POSTMASTER_DB_PATH ?? "/data/tracker.sqlite");
const backupDir = resolve(process.env.POSTMASTER_BACKUP_DIR ?? "/backups");
const retentionDays = Number(process.env.POSTMASTER_BACKUP_RETENTION_DAYS ?? 7);
const dryRun = process.argv.includes("--dry-run");

if (!Number.isInteger(retentionDays) || retentionDays < 1)
  throw new Error(
    "POSTMASTER_BACKUP_RETENTION_DAYS must be a positive integer",
  );
const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const destination = join(backupDir, `postmaster-${stamp}.db`);

if (dryRun) {
  console.log(
    JSON.stringify({
      dbPath,
      backupDir,
      destination,
      retentionDays,
      dryRun: true,
    }),
  );
  process.exit(0);
}

mkdirSync(dirname(destination), { recursive: true });
mkdirSync(backupDir, { recursive: true });
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  // VACUUM INTO takes a consistent SQLite snapshot and does not stop the app.
  db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
for (const name of readdirSync(backupDir)) {
  if (!/^postmaster-.*\.db$/.test(name)) continue;
  const path = join(backupDir, name);
  if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
}
console.log(
  `Created ${destination}; retained backups newer than ${retentionDays} days.`,
);
