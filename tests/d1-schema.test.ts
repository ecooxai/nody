import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workerStateDir = path.resolve("worker/.wrangler/state/v3/d1");

function findSqliteDatabase(dir: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findSqliteDatabase(fullPath);
      if (nested) return nested;
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".sqlite")) {
      return fullPath;
    }
  }
  return null;
}

function querySqlite(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
  return JSON.parse(output) as Array<Record<string, unknown>>;
}

describe("D1 schema", () => {
  let dbPath: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "worker:migrate:local"], { stdio: "inherit" });

    const databasePath = findSqliteDatabase(workerStateDir);
    if (!databasePath) {
      throw new Error(`Could not find a local D1 database under ${workerStateDir}`);
    }
    dbPath = databasePath;
  });

  it("initializes the expected tables", () => {
    const rows = querySqlite(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    const tableNames = rows.map((row) => String(row.name));

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "documents",
        "document_assets",
        "folders",
        "folder_assets",
        "prompt_templates",
        "provider_settings",
        "sync_events",
        "d1_migrations",
      ]),
    );
  });

  it("includes the columns the worker writes to", () => {
    const folderColumns = querySqlite(dbPath, "PRAGMA table_info(folders);").map((row) => String(row.name));
    const documentColumns = querySqlite(dbPath, "PRAGMA table_info(documents);").map((row) => String(row.name));
    const providerColumns = querySqlite(dbPath, "PRAGMA table_info(provider_settings);").map((row) => String(row.name));

    expect(folderColumns).toContain("parent_folder_id");
    expect(documentColumns).toContain("folder_id");
    expect(providerColumns).toContain("live_model");
    expect(providerColumns).toContain("image_model");
    expect(providerColumns).toContain("live_echo_cancellation");
    expect(providerColumns).toContain("live_noise_suppression");
    expect(providerColumns).toContain("live_standby_enabled");
    expect(providerColumns).toContain("live_auto_gain_control");
    expect(providerColumns).toContain("live_silence_trim");
    expect(providerColumns).toContain("live_speech_threshold");
    expect(providerColumns).toContain("live_trim_sensitivity");
  });

  it("records the repair migration", () => {
    const rows = querySqlite(dbPath, "SELECT name FROM d1_migrations ORDER BY id;");
    const migrationNames = rows.map((row) => String(row.name));

    expect(migrationNames).toContain("0004_repair_folders_parent_folder_id.sql");
    expect(migrationNames).toContain("0005_ai_prompts.sql");
    expect(migrationNames).toContain("0008_live_recording_settings.sql");
    expect(migrationNames).toContain("0009_raise_live_speech_threshold.sql");
    expect(migrationNames).toContain("0010_raise_live_speech_threshold_again.sql");
    expect(migrationNames).toContain("0011_live_standby_enabled.sql");
  });
});
