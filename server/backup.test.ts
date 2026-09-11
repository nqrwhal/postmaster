import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

test("SQLite backup and restore preserve data", () => {
  const dir = mkdtempSync(join(tmpdir(), "postmaster-restore-")),
    path = join(dir, "tracker.sqlite");
  let db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('before')",
  );
  db.close();
  const env = {
    ...process.env,
    POSTMASTER_DB_PATH: path,
    POSTMASTER_BACKUP_DIR: dir,
  };
  try {
    execFileSync(process.execPath, ["deploy/backup.mjs"], {
      env,
      stdio: "pipe",
    });
    db = new DatabaseSync(path);
    db.exec("UPDATE sample SET value='after'");
    db.close();
    execFileSync(
      process.execPath,
      [
        "deploy/restore.mjs",
        join(
          dir,
          readdirSync(dir).find((f) => f.endsWith(".db"))!,
        ),
      ],
      { env: { ...env, POSTMASTER_RESTORE_CONFIRMED: "1" }, stdio: "pipe" },
    );
    db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT value FROM sample").get()?.value, "before");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
