import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  RequestListener,
  Server,
  ServerResponse,
} from "node:http";
import path from "node:path";

import { fetchCaddyState as defaultFetchCaddyState, syncCaddyConfig as defaultSyncCaddyConfig } from "./caddy.js";
import { mergeConfiguredApps } from "./caddy-routes.js";
import { errorMessage, errorStatus, PublicError } from "./errors.js";
import {
  executeAction as defaultExecuteAction,
  inspectApp as defaultInspectApp,
} from "./process-manager.js";
import type {
  ActionName,
  ActionResponse,
  ActionResult,
  CaddyState,
  InspectedApp,
  LocaldeckConfig,
  LocaldeckStoreLike,
  ManagedApp,
  Snapshot,
} from "./types.js";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

type FetchCaddyState = (config: LocaldeckConfig) => Promise<CaddyState>;
type SyncCaddyConfig = (config: LocaldeckConfig) => Promise<unknown>;
type InspectApp = (app: ManagedApp) => Promise<InspectedApp>;
type ExecuteAction = (
  app: ManagedApp,
  action: ActionName,
  options: { appLogDirectory: string },
) => Promise<ActionResult>;

export type LocaldeckHttpDependencies = {
  store: LocaldeckStoreLike;
  staticRoot: string;
  appLogDirectory: string;
  fetchCaddyState?: FetchCaddyState;
  syncCaddyConfig?: SyncCaddyConfig;
  inspectApp?: InspectApp;
  executeAction?: ExecuteAction;
  now?: () => Date;
  logger?: Pick<Console, "error">;
};

export type LocaldeckApplication = {
  requestHandler: RequestListener;
  snapshot(): Promise<Snapshot>;
  synchronizeCaddy(): Promise<void>;
  reconcileCaddyIfNeeded(): Promise<void>;
};

function securityHeaders(contentType: string): OutgoingHttpHeaders {
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

export function caddyIsInSync(caddy: CaddyState, config: LocaldeckConfig): boolean {
  const dashboardRoute = caddy.routes.find((route) => route.host === config.dashboard.host);
  const managedRoutes = caddy.routes.filter((route) => route.host !== config.dashboard.host);
  return Boolean(
    caddy.connected &&
      dashboardRoute?.upstreams.includes(
        `${config.dashboard.bind}:${config.dashboard.port}`,
      ) &&
      managedRoutes.length === config.apps.length &&
      config.apps.every((app) =>
        caddy.routes.some(
          (route) => route.host === app.host && route.upstreams.includes(app.upstream),
        ),
      ),
  );
}

export function createLocaldeckApplication(
  dependencies: LocaldeckHttpDependencies,
): LocaldeckApplication {
  const {
    store,
    staticRoot,
    appLogDirectory,
    fetchCaddyState = defaultFetchCaddyState,
    syncCaddyConfig = defaultSyncCaddyConfig,
    inspectApp = defaultInspectApp,
    executeAction = defaultExecuteAction,
    now = () => new Date(),
    logger = console,
  } = dependencies;
  const actionLocks = new Set<string>();
  let syncQueue: Promise<void> = Promise.resolve();

  function synchronizeCaddy(): Promise<void> {
    const task = syncQueue.then(async () => {
      await syncCaddyConfig(store.getConfig());
    });
    syncQueue = task.catch(() => undefined);
    return task;
  }

  async function reconcileCaddyIfNeeded(): Promise<void> {
    const config = store.getConfig();
    const caddy = await fetchCaddyState(config);
    if (caddy.connected && !caddyIsInSync(caddy, config)) await synchronizeCaddy();
  }

  async function snapshot(): Promise<Snapshot> {
    const config = store.getConfig();
    const caddy = await fetchCaddyState(config);
    const merged = mergeConfiguredApps(caddy.routes, config);
    const apps = await Promise.all(merged.map(inspectApp));
    const online = apps.filter((app) => app.status === "online").length;
    const managedRoutes = caddy.routes.filter(
      (route) => route.host !== config.dashboard.host,
    );
    const inSync = caddyIsInSync(caddy, config);

    return {
      generatedAt: now().toISOString(),
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

  function trustedMutationRequest(request: IncomingMessage): boolean {
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

  async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > 64 * 1024) throw new PublicError("リクエストが大きすぎます", 413);
      chunks.push(buffer);
    }
    if (chunks.length === 0) throw new PublicError("アプリ設定がありません");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new PublicError("JSONの形式が不正です");
    }
  }

  async function sendMutationResult(
    response: ServerResponse,
    status: number,
    message: string,
  ): Promise<void> {
    let warning: string | null = null;
    try {
      await synchronizeCaddy();
    } catch (error) {
      warning = errorMessage(error, "Caddyとの同期に失敗しました");
    }
    sendJson(response, status, {
      ok: true,
      message: warning ? `${message}。ただしCaddyへの反映に失敗しました` : message,
      warning,
      snapshot: await snapshot(),
    } satisfies ActionResponse);
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (request.method === "GET" && pathname === "/api/health") {
      const config = store.getConfig();
      sendJson(response, 200, {
        ok: true,
        name: config.dashboard.name,
        host: config.dashboard.host,
        now: now().toISOString(),
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
      } satisfies ActionResponse);
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
      const appId = appMatch[1];
      const app = store.updateApp(appId, await readJsonBody(request));
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
      await sendMutationResult(
        response,
        200,
        `${app.name}の登録とCaddy routeを削除しました`,
      );
      return true;
    }

    const actionMatch = pathname.match(
      /^\/api\/apps\/([a-z0-9-]+)\/(start|restart|stop)$/,
    );
    if (request.method === "POST" && actionMatch) {
      if (!trustedMutationRequest(request)) {
        throw new PublicError("この操作リクエストは許可されていません", 403);
      }
      const appId = actionMatch[1];
      const action = actionMatch[2] as ActionName;
      if (actionLocks.has(appId)) {
        throw new PublicError("このアプリは別の操作を実行中です", 409);
      }

      actionLocks.add(appId);
      try {
        const config = store.getConfig();
        const caddy = await fetchCaddyState(config);
        const app = mergeConfiguredApps(caddy.routes, config).find(
          (candidate) => candidate.id === appId,
        );
        if (!app) throw new PublicError("アプリが見つかりません", 404);

        const result = await executeAction(app, action, { appLogDirectory });
        sendJson(response, 200, {
          ok: true,
          ...result,
          snapshot: await snapshot(),
        } satisfies ActionResponse);
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

  async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
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
          "画面がまだビルドされていません。npm run build を実行してください",
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

  const requestHandler: RequestListener = async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (await handleApi(request, response, requestUrl.pathname)) return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new PublicError("Method Not Allowed", 405);
      }
      await serveStatic(response, requestUrl.pathname);
    } catch (error) {
      const status = error instanceof PublicError ? error.status : (errorStatus(error) ?? 500);
      const isPublic = error instanceof PublicError || errorStatus(error) !== undefined;
      const message = isPublic
        ? error instanceof Error
          ? error.message
          : typeof error === "object" && error && "message" in error && typeof error.message === "string"
            ? error.message
            : "Localdeck 内部で予期しないエラーが発生しました"
        : "Localdeck 内部で予期しないエラーが発生しました";
      if (!response.headersSent) sendJson(response, status, { ok: false, error: message });
      else response.destroy();
      if (!(error instanceof PublicError)) logger.error(error);
    }
  };

  return { requestHandler, snapshot, synchronizeCaddy, reconcileCaddyIfNeeded };
}

export function createLocaldeckServer(
  dependencies: LocaldeckHttpDependencies,
): LocaldeckApplication & { server: Server } {
  const application = createLocaldeckApplication(dependencies);
  const server = http.createServer(application.requestHandler);
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  return { ...application, server };
}
