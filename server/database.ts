import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  mergeAppInput,
  normalizeAppDefinition,
  requestedAppId,
  validateConfig,
} from "./config.js";
import { errorCode, PublicError } from "./errors.js";
import type {
  AppDefinition,
  LegacyConfig,
  LocaldeckConfig,
  LocaldeckStoreLike,
} from "./types.js";

const DEFAULT_CONFIG: LocaldeckConfig = {
  version: 1,
  caddyAdminUrl: "http://127.0.0.1:2019/config/",
  dashboard: {
    name: "Localdeck",
    host: "apps.localhost",
    bind: "127.0.0.1",
    port: 4545,
  },
  apps: [],
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS localdeck_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dashboard_name TEXT NOT NULL,
    dashboard_host TEXT NOT NULL,
    dashboard_bind TEXT NOT NULL,
    dashboard_port INTEGER NOT NULL CHECK (dashboard_port BETWEEN 1 AND 65535),
    caddy_admin_url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL UNIQUE,
    upstream TEXT NOT NULL,
    directory TEXT,
    required_environment_json TEXT NOT NULL DEFAULT '[]',
    lifecycle_json TEXT,
    proxy_json TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`;

type SqliteRow = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function requiredText(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`SQLiteの${key}が文字列ではありません`);
  }
  return value;
}

function rowToApp(row: SqliteRow | undefined): AppDefinition | null {
  if (!row) return null;
  const directory = row.directory;
  return normalizeAppDefinition({
    id: requiredText(row, "id"),
    name: requiredText(row, "name"),
    description: requiredText(row, "description"),
    host: requiredText(row, "host"),
    upstream: requiredText(row, "upstream"),
    directory: typeof directory === "string" ? directory : null,
    requiredEnvironment: parseJson<unknown>(row.required_environment_json, []),
    lifecycle: parseJson<unknown>(row.lifecycle_json, null),
    proxy: parseJson<unknown>(row.proxy_json, {}),
  });
}

function sqliteConflict(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("apps.id")) {
    return new PublicError("同じアプリIDがすでに登録されています", 409);
  }
  if (message.includes("apps.host")) {
    return new PublicError("同じホストがすでに登録されています", 409);
  }
  return error;
}

function now(): string {
  return new Date().toISOString();
}

export class LocaldeckStore implements LocaldeckStoreLike {
  constructor(
    private readonly database: DatabaseSync,
    readonly databasePath: string,
  ) {}

  getConfig(): LocaldeckConfig {
    const settings = this.database
      .prepare("SELECT * FROM localdeck_settings WHERE singleton = 1")
      .get() as SqliteRow | undefined;
    if (!settings) throw new Error("Localdeckの設定が初期化されていません");
    const port = settings.dashboard_port;
    if (typeof port !== "number") {
      throw new Error("SQLiteのdashboard_portが数値ではありません");
    }
    return {
      version: 1,
      caddyAdminUrl: requiredText(settings, "caddy_admin_url"),
      dashboard: {
        name: requiredText(settings, "dashboard_name"),
        host: requiredText(settings, "dashboard_host"),
        bind: requiredText(settings, "dashboard_bind"),
        port,
      },
      apps: this.listApps(),
    };
  }

  listApps(): AppDefinition[] {
    return this.database
      .prepare("SELECT * FROM apps ORDER BY position ASC, name COLLATE NOCASE ASC")
      .all()
      .map((row) => rowToApp(row as SqliteRow))
      .filter((app): app is AppDefinition => app !== null);
  }

  getApp(id: string): AppDefinition | null {
    const row = this.database.prepare("SELECT * FROM apps WHERE id = ?").get(id);
    return rowToApp(row as SqliteRow | undefined);
  }

  createApp(input: unknown): AppDefinition {
    const app = normalizeAppDefinition(input);
    const row = this.database
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM apps")
      .get() as SqliteRow | undefined;
    const position = row?.next_position;
    if (typeof position !== "number") {
      throw new Error("SQLiteから次のアプリ表示位置を取得できませんでした");
    }
    try {
      this.insertAppRecord(app, position);
    } catch (error) {
      throw sqliteConflict(error);
    }
    const created = this.getApp(app.id);
    if (!created) throw new Error("登録したアプリをSQLiteから取得できませんでした");
    return created;
  }

  updateApp(id: string, input: unknown): AppDefinition | null {
    const current = this.getApp(id);
    if (!current) return null;
    const inputId = requestedAppId(input);
    if (inputId && inputId !== id) throw new Error("アプリIDは変更できません");
    const app = normalizeAppDefinition(mergeAppInput(current, input, id));
    try {
      this.database
        .prepare(`
          UPDATE apps SET
            name = ?, description = ?, host = ?, upstream = ?, directory = ?,
            required_environment_json = ?, lifecycle_json = ?, proxy_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          app.name,
          app.description,
          app.host,
          app.upstream,
          app.directory,
          JSON.stringify(app.requiredEnvironment),
          app.lifecycle ? JSON.stringify(app.lifecycle) : null,
          JSON.stringify(app.proxy),
          now(),
          id,
        );
    } catch (error) {
      throw sqliteConflict(error);
    }
    return this.getApp(id);
  }

  deleteApp(id: string): AppDefinition | null {
    const current = this.getApp(id);
    if (!current) return null;
    this.database.prepare("DELETE FROM apps WHERE id = ?").run(id);
    return current;
  }

  close(): void {
    this.database.close();
  }

  insertAppRecord(app: AppDefinition, position: number): void {
    const timestamp = now();
    this.database
      .prepare(`
        INSERT INTO apps (
          id, name, description, host, upstream, directory,
          required_environment_json, lifecycle_json, proxy_json,
          position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        app.id,
        app.name,
        app.description,
        app.host,
        app.upstream,
        app.directory,
        JSON.stringify(app.requiredEnvironment),
        app.lifecycle ? JSON.stringify(app.lifecycle) : null,
        JSON.stringify(app.proxy),
        position,
        timestamp,
        timestamp,
      );
  }
}

async function readLegacyConfig(legacyConfigPath?: string): Promise<LegacyConfig> {
  if (!legacyConfigPath) return DEFAULT_CONFIG;
  try {
    const raw = await readFile(legacyConfigPath, "utf8");
    return validateConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return DEFAULT_CONFIG;
    throw error;
  }
}

export async function openLocaldeckStore({
  databasePath,
  legacyConfigPath,
}: {
  databasePath: string;
  legacyConfigPath?: string;
}): Promise<LocaldeckStore> {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA);

  const existing = database
    .prepare("SELECT singleton FROM localdeck_settings WHERE singleton = 1")
    .get();
  if (!existing) {
    const legacy = await readLegacyConfig(legacyConfigPath);
    const store = new LocaldeckStore(database, databasePath);
    database.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = now();
      database
        .prepare(`
          INSERT INTO localdeck_settings (
            singleton, dashboard_name, dashboard_host, dashboard_bind,
            dashboard_port, caddy_admin_url, created_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          legacy.dashboard.name ?? "Localdeck",
          legacy.dashboard.host,
          legacy.dashboard.bind ?? "127.0.0.1",
          legacy.dashboard.port,
          legacy.caddyAdminUrl ?? DEFAULT_CONFIG.caddyAdminUrl,
          timestamp,
          timestamp,
        );
      for (const [index, input] of (legacy.apps ?? []).entries()) {
        store.insertAppRecord(normalizeAppDefinition(input), index);
      }
      database.exec("PRAGMA user_version = 1");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }

  database.exec("PRAGMA optimize");
  return new LocaldeckStore(database, databasePath);
}
