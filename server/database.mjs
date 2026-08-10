import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeAppDefinition, PublicError, validateConfig } from "./core.mjs";

const DEFAULT_CONFIG = {
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

function parseJson(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    host: row.host,
    upstream: row.upstream,
    directory: row.directory,
    requiredEnvironment: parseJson(row.required_environment_json, []),
    lifecycle: parseJson(row.lifecycle_json, null),
    proxy: parseJson(row.proxy_json, {}),
  };
}

function sqliteConflict(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("apps.id")) {
    return new PublicError("同じアプリIDがすでに登録されています", 409);
  }
  if (message.includes("apps.host")) {
    return new PublicError("同じホストがすでに登録されています", 409);
  }
  return error;
}

function now() {
  return new Date().toISOString();
}

export class LocaldeckStore {
  constructor(database, databasePath) {
    this.database = database;
    this.databasePath = databasePath;
  }

  getConfig() {
    const settings = this.database
      .prepare("SELECT * FROM localdeck_settings WHERE singleton = 1")
      .get();
    if (!settings) throw new Error("Localdeckの設定が初期化されていません");
    return {
      version: 1,
      caddyAdminUrl: settings.caddy_admin_url,
      dashboard: {
        name: settings.dashboard_name,
        host: settings.dashboard_host,
        bind: settings.dashboard_bind,
        port: settings.dashboard_port,
      },
      apps: this.listApps(),
    };
  }

  listApps() {
    return this.database
      .prepare("SELECT * FROM apps ORDER BY position ASC, name COLLATE NOCASE ASC")
      .all()
      .map(rowToApp);
  }

  getApp(id) {
    return rowToApp(this.database.prepare("SELECT * FROM apps WHERE id = ?").get(id));
  }

  createApp(input) {
    const app = normalizeAppDefinition(input);
    const position = this.database
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM apps")
      .get().next_position;
    try {
      this.insertAppRecord(app, position);
    } catch (error) {
      throw sqliteConflict(error);
    }
    return this.getApp(app.id);
  }

  updateApp(id, input) {
    const current = this.getApp(id);
    if (!current) return null;
    if (input?.id && input.id !== id) throw new Error("アプリIDは変更できません");
    const app = normalizeAppDefinition({ ...current, ...input, id });
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

  deleteApp(id) {
    const current = this.getApp(id);
    if (!current) return null;
    this.database.prepare("DELETE FROM apps WHERE id = ?").run(id);
    return current;
  }

  close() {
    this.database.close();
  }

  insertAppRecord(app, position) {
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

async function readLegacyConfig(legacyConfigPath) {
  if (!legacyConfigPath) return DEFAULT_CONFIG;
  try {
    const raw = await readFile(legacyConfigPath, "utf8");
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return DEFAULT_CONFIG;
    throw error;
  }
}

export async function openLocaldeckStore({ databasePath, legacyConfigPath }) {
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
