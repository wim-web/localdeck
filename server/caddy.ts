import { usesGateway } from "./supervisor.js";
import { extractCaddyRoutes } from "./caddy-routes.js";
import { errorMessage } from "./errors.js";
import type { CaddyState, LocaldeckConfig } from "./types.js";

export class CaddyError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "CaddyError";
    this.status = status;
  }
}

function adminUrl(config: LocaldeckConfig, pathname: string): URL {
  const configured = new URL(config.caddyAdminUrl);
  return new URL(pathname, configured.origin);
}

function caddyToken(value: string | number): string {
  return JSON.stringify(String(value));
}

function renderSite(
  host: string,
  upstream: string,
  proxy: { headerUpHost?: string } = {},
): string {
  const proxyLines = proxy.headerUpHost
    ? [
        `\treverse_proxy ${caddyToken(upstream)} {`,
        `\t\theader_up Host ${caddyToken(proxy.headerUpHost)}`,
        "\t}",
      ]
    : [`\treverse_proxy ${caddyToken(upstream)}`];
  return [`${caddyToken(host)} {`, "\ttls internal", ...proxyLines, "}"].join(
    "\n",
  );
}

export function routeUpstream(
  config: LocaldeckConfig,
  app: LocaldeckConfig["apps"][number],
): string {
  return usesGateway(app)
    ? `${config.dashboard.bind}:${config.dashboard.port}`
    : app.upstream;
}

export function renderCaddyfile(config: LocaldeckConfig): string {
  const configured = new URL(config.caddyAdminUrl);
  const adminAddress = `${configured.hostname}:${configured.port || "2019"}`;
  const sites = [
    renderSite(
      config.dashboard.host,
      `${config.dashboard.bind}:${config.dashboard.port}`,
    ),
    ...config.apps.map((app) =>
      renderSite(
        app.host,
        routeUpstream(config, app),
        usesGateway(app) ? {} : app.proxy,
      ),
    ),
  ];
  return ["{", `\tadmin ${adminAddress}`, "}", "", sites.join("\n\n"), ""].join(
    "\n",
  );
}

export async function fetchCaddyState(
  config: LocaldeckConfig,
): Promise<CaddyState> {
  const startedAt = performance.now();
  try {
    const response = await fetch(adminUrl(config, "/config/"), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = (await response.json()) as unknown;
    return {
      connected: true,
      routes: extractCaddyRoutes(raw),
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      error: null,
    };
  } catch (error) {
    return {
      connected: false,
      routes: [],
      latencyMs: null,
      error: errorMessage(error, "接続できませんでした"),
    };
  }
}

export async function syncCaddyConfig(
  config: LocaldeckConfig,
): Promise<{ ok: true; caddyfile: string }> {
  let response: Response;
  try {
    response = await fetch(adminUrl(config, "/load"), {
      method: "POST",
      headers: {
        "Cache-Control": "must-revalidate",
        "Content-Type": "text/caddyfile",
      },
      body: renderCaddyfile(config),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new CaddyError(
      `Caddyへ接続できませんでした: ${errorMessage(error, "不明なエラー")}`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new CaddyError(
      `Caddy設定を適用できませんでした (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return { ok: true, caddyfile: renderCaddyfile(config) };
}
