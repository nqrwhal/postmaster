#!/usr/bin/env node
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const source = process.argv[2];
const dbPath = resolve(
  process.env.POSTMASTER_DB_PATH ?? "/data/tracker.sqlite",
);
if (!source || process.argv.includes("--help")) {
  console.error(
    "Usage: node deploy/restore.mjs /backups/postmaster-<timestamp>.db",
  );
  process.exit(source ? 0 : 2);
}
const backup = resolve(source);
if (!existsSync(backup)) throw new Error(`Backup does not exist: ${backup}`);
if (process.env.POSTMASTER_RESTORE_CONFIRMED !== "1") {
  throw new Error(
    "Stop the postmaster service first, then set POSTMASTER_RESTORE_CONFIRMED=1 to restore",
  );
}
if (existsSync(dbPath)) {
  const check = new DatabaseSync(dbPath, { readOnly: true });
  try {
    check.prepare("PRAGMA integrity_check").get();
  } finally {
    check.close();
  }
}
const check = new DatabaseSync(backup, { readOnly: true });
try {
  const result = check.prepare("PRAGMA integrity_check").get();
  if (result.integrity_check !== "ok")
    throw new Error("Backup failed SQLite integrity_check");
} finally {
  check.close();
}

mkdirSync(dirname(dbPath), { recursive: true });
const temporary = `${dbPath}.restore-${process.pid}`;
copyFileSync(backup, temporary);
// Writers must be stopped. Old WAL pages must never be replayed into the restored file.
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
}
renameSync(temporary, dbPath);
console.log(`Restored ${backup} to ${dbPath}.`);
