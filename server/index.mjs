import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PublicError,
  executeAction,
  inspectApp,
  mergeConfiguredApps,
} from "./core.mjs";
import { fetchCaddyState, syncCaddyConfig } from "./caddy.mjs";
import { openLocaldeckStore } from "./database.mjs";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "..");
const staticRoot = path.join(projectRoot, "dist-local");
const pidFile = path.join(projectRoot, "state", "localdeck.pid");
const legacyConfigPath = process.env.LOCALDECK_CONFIG
  ? path.resolve(process.env.LOCALDECK_CONFIG)
  : path.join(projectRoot, "apps.config.json");
const databasePath = process.env.LOCALDECK_DATABASE
  ? path.resolve(process.env.LOCALDECK_DATABASE)
  : path.join(projectRoot, "state", "localdeck.sqlite");
const store = await openLocaldeckStore({ databasePath, legacyConfigPath });
const startupConfig = store.getConfig();
const actionLocks = new Set();
let syncQueue = Promise.resolve();
let reconcileTimer = null;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function securityHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

function synchronizeCaddy() {
  const task = syncQueue.then(() => syncCaddyConfig(store.getConfig()));
  syncQueue = task.catch(() => undefined);
  return task;
}

function caddyIsInSync(caddy, config) {
  const dashboardRoute = caddy.routes.find((route) => route.host === config.dashboard.host);
  const managedRoutes = caddy.routes.filter((route) => route.host !== config.dashboard.host);
  return Boolean(
    caddy.connected &&
      dashboardRoute?.upstreams.includes(`${config.dashboard.bind}:${config.dashboard.port}`) &&
      managedRoutes.length === config.apps.length &&
      config.apps.every((app) =>
        caddy.routes.some(
          (route) => route.host === app.host && route.upstreams.includes(app.upstream),
        ),
      )
  );
}

async function reconcileCaddyIfNeeded() {
  const config = store.getConfig();
  const caddy = await fetchCaddyState(config);
  if (caddy.connected && !caddyIsInSync(caddy, config)) await synchronizeCaddy();
}

async function snapshot() {
  const config = store.getConfig();
  const caddy = await fetchCaddyState(config);
  const merged = mergeConfiguredApps(caddy.routes, config);
  const apps = await Promise.all(merged.map(inspectApp));
  const online = apps.filter((app) => app.status === "online").length;
  const managedRoutes = caddy.routes.filter((route) => route.host !== config.dashboard.host);
  const inSync = caddyIsInSync(caddy, config);

  return {
    generatedAt: new Date().toISOString(),
    caddy: {
      connected: caddy.connected,
      routeCount: managedRoutes.length,
      expectedRouteCount: config.apps.length,
      totalRouteCount: caddy.routes.length,
      inSync,
      latencyMs: caddy.latencyMs,
      error: caddy.error,
    },
    summary: {
      total: apps.length,
      online,
      offline: apps.length - online,
    },
    apps,
  };
}

function trustedMutationRequest(request) {
  if (request.headers["x-localdeck-action"] !== "1") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const config = store.getConfig();
    const allowedHosts = new Set([
      config.dashboard.host,
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]);
    return ["http:", "https:"].includes(url.protocol) && allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new PublicError("リクエストが大きすぎます", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw new PublicError("アプリ設定がありません");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PublicError("JSONの形式が不正です");
  }
}

async function sendMutationResult(response, status, message) {
  let warning = null;
  try {
    await synchronizeCaddy();
  } catch (error) {
    warning = error instanceof Error ? error.message : "Caddyとの同期に失敗しました";
  }
  sendJson(response, status, {
    ok: true,
    message: warning ? `${message}。ただしCaddyへの反映に失敗しました` : message,
    warning,
    snapshot: await snapshot(),
  });
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/health") {
    const config = store.getConfig();
    sendJson(response, 200, {
      ok: true,
      name: config.dashboard.name,
      host: config.dashboard.host,
      now: new Date().toISOString(),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/apps") {
    sendJson(response, 200, await snapshot());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/caddy/sync") {
    if (!trustedMutationRequest(request)) {
      throw new PublicError("この操作リクエストは許可されていません", 403);
    }
    await synchronizeCaddy();
    sendJson(response, 200, {
      ok: true,
      message: "SQLiteの登録内容をCaddyへ反映しました",
      snapshot: await snapshot(),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/apps") {
    if (!trustedMutationRequest(request)) {
      throw new PublicError("この操作リクエストは許可されていません", 403);
    }
    const app = store.createApp(await readJsonBody(request));
    await sendMutationResult(response, 201, `${app.name}を登録しました`);
    return true;
  }

  const appMatch = pathname.match(/^\/api\/apps\/([a-z0-9-]+)$/);
  if (request.method === "PUT" && appMatch) {
    if (!trustedMutationRequest(request)) {
      throw new PublicError("この操作リクエストは許可されていません", 403);
    }
    const app = store.updateApp(appMatch[1], await readJsonBody(request));
    if (!app) throw new PublicError("アプリが見つかりません", 404);
    await sendMutationResult(response, 200, `${app.name}の設定を更新しました`);
    return true;
  }

  if (request.method === "DELETE" && appMatch) {
    if (!trustedMutationRequest(request)) {
      throw new PublicError("この操作リクエストは許可されていません", 403);
    }
    const appId = appMatch[1];
    if (actionLocks.has(appId)) {
      throw new PublicError("このアプリは別の操作を実行中です", 409);
    }
    const app = store.deleteApp(appId);
    if (!app) throw new PublicError("アプリが見つかりません", 404);
    await sendMutationResult(response, 200, `${app.name}の登録とCaddy routeを削除しました`);
    return true;
  }

  const actionMatch = pathname.match(/^\/api\/apps\/([a-z0-9-]+)\/(start|restart|stop)$/);
  if (request.method === "POST" && actionMatch) {
    if (!trustedMutationRequest(request)) {
      throw new PublicError("この操作リクエストは許可されていません", 403);
    }
    const [, appId, action] = actionMatch;
    if (actionLocks.has(appId)) {
      throw new PublicError("このアプリは別の操作を実行中です", 409);
    }

    const config = store.getConfig();
    const caddy = await fetchCaddyState(config);
    const app = mergeConfiguredApps(caddy.routes, config).find(
      (candidate) => candidate.id === appId,
    );
    if (!app) throw new PublicError("アプリが見つかりません", 404);

    actionLocks.add(appId);
    try {
      const result = await executeAction(app, action);
      sendJson(response, 200, {
        ok: true,
        ...result,
        snapshot: await snapshot(),
      });
    } finally {
      actionLocks.delete(appId);
    }
    return true;
  }

  if (pathname.startsWith("/api/")) {
    throw new PublicError("API が見つかりません", 404);
  }
  return false;
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(staticRoot, relativePath);
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) {
    throw new PublicError("ファイルが見つかりません", 404);
  }

  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
    await access(filePath);
  } catch {
    filePath = path.join(staticRoot, "index.html");
    try {
      await access(filePath);
    } catch {
      throw new PublicError(
        "画面がまだビルドされていません。npm run build:local を実行してください",
        503,
      );
    }
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[extension] ?? "application/octet-stream";
  const headers = securityHeaders(contentType);
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  response.writeHead(200, headers);
  createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (await handleApi(request, response, requestUrl.pathname)) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new PublicError("Method Not Allowed", 405);
    }
    await serveStatic(response, requestUrl.pathname);
  } catch (error) {
    const status =
      error instanceof PublicError
        ? error.status
        : Number.isInteger(error?.status)
          ? error.status
          : 500;
    const message =
      error instanceof PublicError || Number.isInteger(error?.status)
        ? error.message
        : "Localdeck 内部で予期しないエラーが発生しました";
    if (!response.headersSent) sendJson(response, status, { ok: false, error: message });
    else response.destroy();
    if (!(error instanceof PublicError)) console.error(error);
  }
});

server.requestTimeout = 130_000;
server.headersTimeout = 10_000;

async function recordPid() {
  await mkdir(path.dirname(pidFile), { recursive: true });
  const temporary = `${pidFile}.tmp.${process.pid}`;
  await writeFile(temporary, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, pidFile);
}

async function clearOwnPid() {
  try {
    const recorded = (await readFile(pidFile, "utf8")).trim();
    if (recorded === String(process.pid)) await unlink(pidFile);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(error);
  }
}

server.listen(startupConfig.dashboard.port, startupConfig.dashboard.bind, async () => {
  try {
    await recordPid();
  } catch (error) {
    console.error("PID file could not be written", error);
  }
  console.log(
    `${startupConfig.dashboard.name} listening on http://${startupConfig.dashboard.bind}:${startupConfig.dashboard.port}`,
  );
  try {
    await synchronizeCaddy();
    console.log("Caddy configuration synchronized from SQLite");
  } catch (error) {
    console.error(
      `Caddy synchronization deferred: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  reconcileTimer = setInterval(() => {
    void reconcileCaddyIfNeeded().catch((error) =>
      console.error(
        `Caddy reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`,
      ),
    );
  }, 15_000);
  reconcileTimer.unref();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconcileTimer) clearInterval(reconcileTimer);
  console.log(`${signal}: shutting down`);
  server.close(async (error) => {
    await clearOwnPid();
    store.close();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
