import { readFile } from "node:fs/promises";
import path from "node:path";

import { PublicError } from "./errors.js";
import type {
  AppDefinition,
  LegacyConfig,
  LifecycleDefinition,
  AppOptions,
  Category,
  PortSettings,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 500,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicError(`${label}を入力してください`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength)
    throw new PublicError(`${label}が長すぎます`);
  return normalized;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength = 500,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string")
    throw new PublicError(`${label}の形式が不正です`);
  const normalized = value.trim();
  if (normalized.length > maxLength)
    throw new PublicError(`${label}が長すぎます`);
  return normalized || null;
}

function positiveInteger(
  value: unknown,
  label: string,
  fallback: number,
): number {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 3_600_000) {
    throw new PublicError(`${label}は100〜3600000ミリ秒で入力してください`);
  }
  return number;
}

function normalizeCommand(
  value: unknown,
  label: string,
  required = false,
): string[] | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new PublicError(`${label}を入力してください`);
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new PublicError(`${label}は引数の配列で入力してください`);
  }
  const command = value.map((item) =>
    requiredString(item, `${label}の引数`, 2000),
  );
  if (command.length > 100) throw new PublicError(`${label}の引数が多すぎます`);
  return command;
}

function normalizeLifecycle(
  value: unknown,
  directory: string | null,
): LifecycleDefinition {
  if (!value || (isRecord(value) && value.strategy === "none")) return null;
  if (!directory || !path.isAbsolute(directory)) {
    throw new PublicError(
      "操作を登録する場合は絶対パスの作業ディレクトリが必要です",
    );
  }
  if (
    !isRecord(value) ||
    (value.strategy !== "commands" && value.strategy !== "process")
  ) {
    throw new PublicError("操作方法はcommandsまたはprocessを選択してください");
  }
  if (value.strategy === "commands") {
    return {
      strategy: "commands",
      start: normalizeCommand(value.start, "起動コマンド"),
      restart: normalizeCommand(value.restart, "再起動コマンド"),
      stop: normalizeCommand(value.stop, "停止コマンド"),
      timeoutMs: positiveInteger(value.timeoutMs, "操作タイムアウト", 120_000),
    };
  }
  return {
    strategy: "process",
    start: normalizeCommand(value.start, "起動コマンド", true) as string[],
    startTimeoutMs: positiveInteger(
      value.startTimeoutMs,
      "起動タイムアウト",
      30_000,
    ),
    stopTimeoutMs: positiveInteger(
      value.stopTimeoutMs,
      "停止タイムアウト",
      15_000,
    ),
  };
}

export const DEFAULT_OPTIONS: AppOptions = {
  categoryId: null,
  port: { mode: "fixed", environment: "" },
  environment: {},
  backends: [],
  wakeOnRequest: false,
  idleStopMinutes: 0,
  activityPath: "",
  requestOnlyIdle: false,
  keepAlive: false,
};

function environmentName(value: unknown): string {
  const name = requiredString(value ?? "PORT", "ポートの環境変数名", 100);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new PublicError("環境変数名の形式が不正です");
  return name;
}

function portSettings(value: unknown): PortSettings {
  const port = isRecord(value) ? value : {};
  if (port.mode !== undefined && port.mode !== "auto" && port.mode !== "fixed")
    throw new PublicError("ポート方式が不正です");
  return {
    mode: port.mode === "auto" ? "auto" : "fixed",
    environment:
      port.environment === "" ||
      (port.environment === undefined && port.mode !== "auto")
        ? ""
        : environmentName(port.environment),
  };
}

function environment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 100)
    throw new PublicError("環境変数の形式が不正です");
  return Object.fromEntries(
    Object.entries(value).map(([key, value]) => {
      environmentName(key);
      if (
        typeof value !== "string" ||
        value.length > 8000 ||
        value.includes("\0")
      )
        throw new PublicError("環境変数の値が不正です");
      return [key, value];
    }),
  );
}

export function normalizeCategory(input: unknown): Category {
  if (!isRecord(input)) throw new PublicError("カテゴリの形式が不正です");
  const id = requiredString(input.id, "カテゴリID", 64);
  if (!/^[a-z0-9-]+$/.test(id)) throw new PublicError("カテゴリIDが不正です");
  const color = requiredString(input.color ?? "blue", "カテゴリ色", 20);
  if (!["blue", "purple", "green", "orange", "pink", "gray"].includes(color))
    throw new PublicError("カテゴリ色が不正です");
  return { id, name: requiredString(input.name, "カテゴリ名", 80), color };
}

function normalizeOptions(value: unknown, app: AppDefinition): AppOptions {
  if (!isRecord(value)) throw new PublicError("追加設定の形式が不正です");
  const port = portSettings(value.port);
  const backendInputs = value.backends ?? [];
  if (!Array.isArray(backendInputs) || backendInputs.length > 12)
    throw new PublicError("バックエンドは12個まで登録できます");
  const ids = new Set<string>();
  const backends = backendInputs.map((backend) => {
    if (!isRecord(backend))
      throw new PublicError("バックエンドの形式が不正です");
    const id = requiredString(backend.id, "バックエンドID", 40);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || id === "main" || ids.has(id))
      throw new PublicError(
        "バックエンドIDは重複しない英小文字・数字・ハイフンで入力してください",
      );
    ids.add(id);
    const directory = requiredString(
      backend.directory || app.directory,
      "バックエンドの作業ディレクトリ",
      2000,
    );
    if (!path.isAbsolute(directory))
      throw new PublicError("作業ディレクトリは絶対パスが必要です");
    const backendPort = Number(backend.port);
    if (
      !Number.isInteger(backendPort) ||
      backendPort < 1 ||
      backendPort > 65535
    )
      throw new PublicError("バックエンドのポートは1〜65535で入力してください");
    return {
      id,
      name: requiredString(backend.name || id, "バックエンド名", 100),
      directory,
      start: normalizeCommand(backend.start, "バックエンド起動コマンド", true)!,
      port: backendPort,
      portSettings: portSettings(backend.portSettings),
      environment: environment(backend.environment),
    };
  });
  if (
    port.mode === "auto" &&
    !port.environment &&
    !app.lifecycle?.start?.some((arg) => arg.includes("{port}"))
  ) {
    throw new PublicError(
      "自動ポートは環境変数名、または起動コマンドの {port} を指定してください",
    );
  }
  for (const backend of backends) {
    if (
      backend.portSettings.mode === "auto" &&
      !backend.portSettings.environment &&
      !backend.start.some((arg) => arg.includes(`{backendPort:${backend.id}}`))
    ) {
      throw new PublicError(
        `${backend.name} のポートを渡す環境変数名または置換を指定してください`,
      );
    }
  }
  if (
    (port.mode === "auto" || backends.length > 0) &&
    app.lifecycle?.strategy !== "process"
  )
    throw new PublicError(
      "自動ポート・バックエンドはプロセス方式で利用できます",
    );
  if (
    port.mode === "auto" &&
    !["localhost", "127.0.0.1", "::1"].includes(
      parseUpstream(app.upstream)!.address,
    )
  )
    throw new PublicError("自動ポートはループバックアドレスを指定してください");
  const idleStopMinutes = Number(value.idleStopMinutes ?? 0);
  if (
    !Number.isInteger(idleStopMinutes) ||
    idleStopMinutes < 0 ||
    idleStopMinutes > 1440
  )
    throw new PublicError("自動停止は0〜1440分で入力してください");
  const activityPath =
    optionalString(value.activityPath, "処理状態の確認パス", 1000) ?? "";
  if (
    activityPath &&
    (!activityPath.startsWith("/") ||
      activityPath.startsWith("//") ||
      /[\r\n\\#]/.test(activityPath))
  )
    throw new PublicError(
      "処理状態は /api/activity のようなパスで指定してください",
    );
  if (idleStopMinutes && !activityPath && value.requestOnlyIdle !== true)
    throw new PublicError(
      "自動停止には処理状態の確認パス、またはバックグラウンド処理なしの指定が必要です",
    );
  if ((value.wakeOnRequest || idleStopMinutes) && !app.lifecycle?.start)
    throw new PublicError("自動起動・停止には起動コマンドが必要です");
  if (idleStopMinutes && app.lifecycle?.strategy !== "process")
    throw new PublicError("自動停止はプロセス方式で利用できます");
  const options: AppOptions = {
    categoryId: optionalString(value.categoryId, "カテゴリ", 64),
    port,
    environment: environment(value.environment),
    backends,
    wakeOnRequest: value.wakeOnRequest === true,
    idleStopMinutes,
    activityPath,
    requestOnlyIdle: value.requestOnlyIdle === true,
    keepAlive: value.keepAlive === true,
  };
  const strings = [
    ...(app.lifecycle?.start ?? []),
    ...Object.values(options.environment),
    ...backends.flatMap((b) => [...b.start, ...Object.values(b.environment)]),
  ];
  for (const text of strings)
    for (const match of text.matchAll(/\{backendPort:([^}]+)\}/g)) {
      if (!ids.has(match[1]))
        throw new PublicError(`バックエンド ${match[1]} が登録されていません`);
    }
  return options;
}

export function parseUpstream(
  dial: unknown,
): { address: string; port: number } | null {
  if (typeof dial !== "string") return null;
  const value = dial.trim();
  const ipv6 = value.match(/^\[([^\]]+)]:(\d+)$/);
  const regular = value.match(/^([^:]+):(\d+)$/);
  const match = ipv6 ?? regular;
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { address: match[1], port };
}

export function normalizeAppDefinition(input: unknown): AppDefinition {
  if (!isRecord(input)) {
    throw new PublicError("アプリ設定の形式が不正です");
  }
  const id = requiredString(input.id, "アプリID", 64).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) {
    throw new PublicError(
      "アプリIDは英小文字・数字・ハイフンで入力してください",
    );
  }
  const host = requiredString(input.host, "ホスト", 253).toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.localhost$/.test(
      host,
    )
  ) {
    throw new PublicError("ホストはexample.localhost形式で入力してください");
  }
  const upstream = requiredString(input.upstream, "upstream", 300);
  if (!parseUpstream(upstream)) {
    throw new PublicError("upstreamはhost:port形式で入力してください");
  }
  const directory = optionalString(input.directory, "作業ディレクトリ", 2000);
  if (directory && !path.isAbsolute(directory)) {
    throw new PublicError("作業ディレクトリは絶対パスで入力してください");
  }
  const requiredEnvironment = Array.isArray(input.requiredEnvironment)
    ? [
        ...new Set(
          input.requiredEnvironment.map((name) =>
            requiredString(name, "環境変数名", 200),
          ),
        ),
      ]
    : [];
  if (
    requiredEnvironment.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  ) {
    throw new PublicError("環境変数名の形式が不正です");
  }
  const proxy = isRecord(input.proxy) ? input.proxy : {};
  const headerUpHost = optionalString(proxy.headerUpHost, "転送Host", 253);
  if (headerUpHost && /[\r\n]/.test(headerUpHost)) {
    throw new PublicError("転送Hostの形式が不正です");
  }
  const app: AppDefinition = {
    id,
    name: requiredString(input.name, "表示名", 120),
    description: optionalString(input.description, "説明", 1000) ?? "",
    host,
    upstream,
    directory,
    requiredEnvironment,
    lifecycle: normalizeLifecycle(input.lifecycle, directory),
    proxy: headerUpHost ? { headerUpHost } : {},
  };
  if (input.options !== undefined)
    app.options = normalizeOptions(input.options, app);
  return app;
}

export function validateConfig(config: unknown): LegacyConfig {
  if (!isRecord(config) || config.version !== 1) {
    throw new Error("apps.config.json の version は 1 である必要があります");
  }
  const dashboard = config.dashboard;
  if (
    !isRecord(dashboard) ||
    typeof dashboard.host !== "string" ||
    !dashboard.host ||
    !Number.isInteger(dashboard.port) ||
    (dashboard.name !== undefined && typeof dashboard.name !== "string") ||
    (dashboard.bind !== undefined && typeof dashboard.bind !== "string") ||
    (config.caddyAdminUrl !== undefined &&
      typeof config.caddyAdminUrl !== "string")
  ) {
    throw new Error("dashboard.host と dashboard.port が必要です");
  }

  const apps = Array.isArray(config.apps) ? config.apps : [];
  const ids = new Set<string>();
  const hosts = new Set<string>();
  for (const input of apps) {
    const app = normalizeAppDefinition(input);
    if (ids.has(app.id))
      throw new Error(`アプリ ID が重複しています: ${app.id}`);
    if (hosts.has(app.host))
      throw new Error(`ホストが重複しています: ${app.host}`);
    ids.add(app.id);
    hosts.add(app.host);
  }
  return config as LegacyConfig;
}

export async function loadConfig(configPath: string): Promise<LegacyConfig> {
  const raw = await readFile(configPath, "utf8");
  return validateConfig(JSON.parse(raw) as unknown);
}

export function mergeAppInput(
  current: AppDefinition,
  input: unknown,
  id: string,
): Record<string, unknown> {
  return {
    ...current,
    ...(isRecord(input) ? input : {}),
    id,
  };
}

export function requestedAppId(input: unknown): unknown {
  return isRecord(input) ? input.id : undefined;
}
