import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const DEFAULT_CONNECT_TIMEOUT_MS = 700;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT = 12_000;

export class PublicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

function collectHosts(route) {
  const hosts = new Set();
  for (const matcher of route?.match ?? []) {
    for (const host of matcher?.host ?? []) {
      if (typeof host === "string" && host.trim()) hosts.add(host.trim());
    }
  }
  return [...hosts];
}

function collectUpstreams(value, upstreams = new Set()) {
  if (!value || typeof value !== "object") return upstreams;

  if (value.handler === "reverse_proxy" && Array.isArray(value.upstreams)) {
    for (const upstream of value.upstreams) {
      if (typeof upstream?.dial === "string" && upstream.dial.trim()) {
        upstreams.add(upstream.dial.trim());
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUpstreams(item, upstreams);
  } else {
    for (const item of Object.values(value)) collectUpstreams(item, upstreams);
  }
  return upstreams;
}

export function parseUpstream(dial) {
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

export function extractCaddyRoutes(config) {
  const found = new Map();
  const servers = config?.apps?.http?.servers;
  if (!servers || typeof servers !== "object") return [];

  for (const [serverName, server] of Object.entries(servers)) {
    for (const route of server?.routes ?? []) {
      const hosts = collectHosts(route);
      const upstreams = [...collectUpstreams(route)];
      if (hosts.length === 0 || upstreams.length === 0) continue;

      for (const host of hosts) {
        const current = found.get(host) ?? {
          host,
          server: serverName,
          upstreams: [],
        };
        current.upstreams = [...new Set([...current.upstreams, ...upstreams])];
        found.set(host, current);
      }
    }
  }

  return [...found.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export function mergeConfiguredApps(routes, config) {
  const routeByHost = new Map(routes.map((route) => [route.host, route]));
  return (config.apps ?? []).map((app) => {
    const route = routeByHost.get(app.host);
    return {
      ...app,
      configured: true,
      caddyRouteFound: Boolean(route),
      upstreams: app.upstream ? [app.upstream] : [],
    };
  });
}

function requiredString(value, label, maxLength = 500) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicError(`${label}を入力してください`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new PublicError(`${label}が長すぎます`);
  return normalized;
}

function optionalString(value, label, maxLength = 500) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new PublicError(`${label}の形式が不正です`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new PublicError(`${label}が長すぎます`);
  return normalized || null;
}

function positiveInteger(value, label, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 3_600_000) {
    throw new PublicError(`${label}は100〜3600000ミリ秒で入力してください`);
  }
  return number;
}

function normalizeCommand(value, label, required = false) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new PublicError(`${label}を入力してください`);
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new PublicError(`${label}は引数の配列で入力してください`);
  }
  const command = value.map((item) => requiredString(item, `${label}の引数`, 2000));
  if (command.length > 100) throw new PublicError(`${label}の引数が多すぎます`);
  return command;
}

function normalizeLifecycle(value, directory) {
  if (!value || value.strategy === "none") return null;
  if (!directory || !path.isAbsolute(directory)) {
    throw new PublicError("操作を登録する場合は絶対パスの作業ディレクトリが必要です");
  }
  if (!['commands', 'process'].includes(value.strategy)) {
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
  const logFile = requiredString(value.logFile, "ログ保存先", 2000);
  if (!path.isAbsolute(logFile)) throw new PublicError("ログ保存先は絶対パスで入力してください");
  return {
    strategy: "process",
    start: normalizeCommand(value.start, "起動コマンド", true),
    logFile,
    startTimeoutMs: positiveInteger(value.startTimeoutMs, "起動タイムアウト", 30_000),
    stopTimeoutMs: positiveInteger(value.stopTimeoutMs, "停止タイムアウト", 15_000),
  };
}

export function normalizeAppDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PublicError("アプリ設定の形式が不正です");
  }
  const id = requiredString(input.id, "アプリID", 64).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) {
    throw new PublicError("アプリIDは英小文字・数字・ハイフンで入力してください");
  }
  const host = requiredString(input.host, "ホスト", 253).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.localhost$/.test(host)) {
    throw new PublicError("ホストはexample.localhost形式で入力してください");
  }
  const upstream = requiredString(input.upstream, "upstream", 300);
  if (!parseUpstream(upstream)) throw new PublicError("upstreamはhost:port形式で入力してください");
  const directory = optionalString(input.directory, "作業ディレクトリ", 2000);
  if (directory && !path.isAbsolute(directory)) {
    throw new PublicError("作業ディレクトリは絶対パスで入力してください");
  }
  const requiredEnvironment = Array.isArray(input.requiredEnvironment)
    ? [...new Set(input.requiredEnvironment.map((name) => requiredString(name, "環境変数名", 200)))]
    : [];
  if (requiredEnvironment.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new PublicError("環境変数名の形式が不正です");
  }
  const headerUpHost = optionalString(input.proxy?.headerUpHost, "転送Host", 253);
  if (headerUpHost && /[\r\n]/.test(headerUpHost)) {
    throw new PublicError("転送Hostの形式が不正です");
  }
  return {
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
}

export function validateConfig(config) {
  if (!config || config.version !== 1) {
    throw new Error("apps.config.json の version は 1 である必要があります");
  }
  if (!config.dashboard?.host || !Number.isInteger(config.dashboard?.port)) {
    throw new Error("dashboard.host と dashboard.port が必要です");
  }

  const ids = new Set();
  const hosts = new Set();
  for (const input of config.apps ?? []) {
    const app = normalizeAppDefinition(input);
    if (ids.has(app.id)) throw new Error(`アプリ ID が重複しています: ${app.id}`);
    if (hosts.has(app.host)) throw new Error(`ホストが重複しています: ${app.host}`);
    ids.add(app.id);
    hosts.add(app.host);
  }
  return config;
}

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  return validateConfig(JSON.parse(raw));
}

export function isPortOpen(address, port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const socket = net.createConnection({ host: address, port });
    let settled = false;

    const finish = (online) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        online,
        latencyMs: online ? Math.max(1, Math.round(performance.now() - startedAt)) : null,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function runCommand(command, options = {}) {
  if (!Array.isArray(command) || command.length === 0) {
    return Promise.reject(new PublicError("実行コマンドが設定されていません"));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;

    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_COMMAND_OUTPUT) output = output.slice(-MAX_COMMAND_OUTPUT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new PublicError(`コマンドを開始できませんでした: ${error.message}`, 500));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const trimmed = output.trim();
      if (timedOut) {
        reject(new PublicError(`操作が ${Math.round(timeoutMs / 1000)} 秒でタイムアウトしました`, 504));
      } else if (code !== 0) {
        reject(
          new PublicError(
            trimmed || `コマンドが終了コード ${code ?? signal ?? "不明"} で失敗しました`,
            500,
          ),
        );
      } else {
        resolve({ output: trimmed, code: code ?? 0 });
      }
    });
  });
}

async function listenerPids(port) {
  try {
    const result = await runCommand(
      ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeoutMs: 3000 },
    );
    return [...new Set(result.output.split(/\s+/).map(Number).filter(Number.isInteger))];
  } catch (error) {
    if (error instanceof PublicError) return [];
    throw error;
  }
}

async function processCwd(pid) {
  try {
    const result = await runCommand(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeoutMs: 3000,
    });
    const cwdLine = result.output.split("\n").find((line) => line.startsWith("n"));
    return cwdLine?.slice(1) ?? null;
  } catch {
    return null;
  }
}

async function processUptime(pid) {
  try {
    const result = await runCommand(["ps", "-p", String(pid), "-o", "etime="], {
      timeoutMs: 3000,
    });
    return result.output.trim() || null;
  } catch {
    return null;
  }
}

async function normalizedRealpath(value) {
  if (!value) return null;
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function assertManagedPid(app, pid) {
  const [actualCwd, expectedCwd] = await Promise.all([
    processCwd(pid).then(normalizedRealpath),
    normalizedRealpath(app.directory),
  ]);
  if (!actualCwd || !expectedCwd || actualCwd !== expectedCwd) {
    throw new PublicError(
      `PID ${pid} の作業ディレクトリが登録内容と一致しないため、停止を拒否しました`,
      409,
    );
  }
}

async function waitForPort(address, port, expectedOnline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await isPortOpen(address, port, 400);
    if (status.online === expectedOnline) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new PublicError(
    expectedOnline
      ? `ポート ${port} が起動待ち時間内に応答しませんでした`
      : `ポート ${port} が停止待ち時間内に閉じませんでした`,
    504,
  );
}

function ensureRequiredEnvironment(app) {
  const missing = (app.requiredEnvironment ?? []).filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new PublicError(
      `Localdeck の起動環境に ${missing.join(", ")} がないため、このアプリを起動できません`,
      409,
    );
  }
}

async function startDetachedProcess(app, endpoint) {
  ensureRequiredEnvironment(app);
  const current = await isPortOpen(endpoint.address, endpoint.port);
  if (current.online) throw new PublicError(`${app.name} はすでに起動しています`, 409);

  const lifecycle = app.lifecycle;
  if (!Array.isArray(lifecycle.start) || lifecycle.start.length === 0) {
    throw new PublicError(`${app.name} の起動コマンドがありません`, 409);
  }

  const logFile = lifecycle.logFile;
  if (!logFile) throw new PublicError(`${app.name} のログ保存先がありません`, 409);
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(logFile, `\n[${new Date().toISOString()}] Localdeck start\n`, "utf8");
  const handle = await open(logFile, "a");

  let child;
  try {
    child = spawn(lifecycle.start[0], lifecycle.start.slice(1), {
      cwd: app.directory,
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["ignore", handle.fd, handle.fd],
    });
  } finally {
    await handle.close();
  }

  const earlyFailure = new Promise((_, reject) => {
    child.once("error", (error) =>
      reject(new PublicError(`起動できませんでした: ${error.message}`, 500)),
    );
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new PublicError(`起動直後に終了しました。ログ: ${logFile}`, 500));
      }
    });
  });
  child.unref();

  await Promise.race([
    waitForPort(
      endpoint.address,
      endpoint.port,
      true,
      lifecycle.startTimeoutMs ?? 30_000,
    ),
    earlyFailure,
  ]);
  return { message: `${app.name} を起動しました`, output: `ログ: ${logFile}` };
}

async function stopDetachedProcess(app, endpoint) {
  const current = await isPortOpen(endpoint.address, endpoint.port);
  if (!current.online) return { message: `${app.name} はすでに停止しています`, output: "" };

  const pids = await listenerPids(endpoint.port);
  if (pids.length === 0) {
    throw new PublicError(`ポート ${endpoint.port} の PID を特定できませんでした`, 409);
  }
  for (const pid of pids) await assertManagedPid(app, pid);
  for (const pid of pids) process.kill(pid, "SIGTERM");
  await waitForPort(
    endpoint.address,
    endpoint.port,
    false,
    app.lifecycle.stopTimeoutMs ?? 15_000,
  );
  return { message: `${app.name} を停止しました`, output: "" };
}

export async function executeAction(app, action) {
  if (!app.configured || !app.lifecycle) {
    throw new PublicError("このルートは監視のみで、操作は登録されていません", 409);
  }
  if (!["start", "restart", "stop"].includes(action)) {
    throw new PublicError("未対応の操作です");
  }

  const endpoint = parseUpstream(app.upstreams?.[0] ?? app.upstream);
  if (!endpoint) throw new PublicError("操作対象のポートを特定できません", 409);

  if (app.lifecycle.strategy === "commands") {
    if (action !== "stop") ensureRequiredEnvironment(app);
    const command = app.lifecycle[action];
    if (!Array.isArray(command)) {
      throw new PublicError(`${action} コマンドが登録されていません`, 409);
    }
    const result = await runCommand(command, {
      cwd: app.directory,
      timeoutMs: app.lifecycle.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    const shouldBeOnline = action !== "stop";
    await waitForPort(endpoint.address, endpoint.port, shouldBeOnline, 5000);
    return {
      message: `${app.name} を${action === "stop" ? "停止" : action === "start" ? "起動" : "再起動"}しました`,
      output: result.output,
    };
  }

  if (action === "start") return startDetachedProcess(app, endpoint);
  if (action === "stop") return stopDetachedProcess(app, endpoint);
  await stopDetachedProcess(app, endpoint);
  return startDetachedProcess(app, endpoint);
}

function actionAvailability(app, online) {
  const missingEnvironment = (app.requiredEnvironment ?? []).filter((name) => !process.env[name]);
  const hasControl = Boolean(app.configured && app.lifecycle);
  const hasStart = Boolean(app.lifecycle?.start);
  const hasRestart = Boolean(
    app.lifecycle?.strategy === "process" || app.lifecycle?.restart,
  );
  const hasStop = Boolean(
    app.lifecycle?.strategy === "process" || app.lifecycle?.stop,
  );
  const environmentReason = missingEnvironment.length
    ? `Localdeck の環境に ${missingEnvironment.join(", ")} がありません`
    : null;

  return {
    start: {
      enabled: hasControl && hasStart && !online && !environmentReason,
      reason: !hasControl
        ? "監視のみ"
        : !hasStart
          ? "起動コマンドがありません"
          : online
            ? "起動中です"
            : environmentReason,
    },
    restart: {
      enabled: hasControl && hasRestart && online && !environmentReason,
      reason: !hasControl
        ? "監視のみ"
        : !hasRestart
          ? "再起動コマンドがありません"
          : !online
            ? "停止中です"
            : environmentReason,
    },
    stop: {
      enabled: hasControl && hasStop && online,
      reason: !hasControl
        ? "監視のみ"
        : !hasStop
          ? "停止コマンドがありません"
          : !online
            ? "停止中です"
            : null,
    },
  };
}

export async function inspectApp(app) {
  const endpoint = parseUpstream(app.upstreams?.[0] ?? app.upstream);
  if (!endpoint) {
    return {
      ...app,
      url: `https://${app.host}`,
      directUrl: null,
      port: null,
      status: "unknown",
      latencyMs: null,
      pid: null,
      uptime: null,
      actions: actionAvailability(app, false),
    };
  }

  const status = await isPortOpen(endpoint.address, endpoint.port);
  const pids = status.online ? await listenerPids(endpoint.port) : [];
  const pid = pids[0] ?? null;
  const uptime = pid ? await processUptime(pid) : null;
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    host: app.host,
    url: `https://${app.host}`,
    directUrl: `http://${endpoint.address}:${endpoint.port}`,
    upstream: `${endpoint.address}:${endpoint.port}`,
    upstreams: app.upstreams,
    port: endpoint.port,
    status: status.online ? "online" : "offline",
    latencyMs: status.latencyMs,
    pid,
    uptime,
    directory: app.directory ?? null,
    configured: app.configured,
    caddyRouteFound: app.caddyRouteFound,
    definition: {
      id: app.id,
      name: app.name,
      description: app.description,
      host: app.host,
      upstream: app.upstream,
      directory: app.directory ?? null,
      requiredEnvironment: app.requiredEnvironment ?? [],
      lifecycle: app.lifecycle ?? null,
      proxy: app.proxy ?? {},
    },
    actions: actionAvailability(app, status.online),
  };
}
