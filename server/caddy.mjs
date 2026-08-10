import { extractCaddyRoutes } from "./core.mjs";

export class CaddyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "CaddyError";
    this.status = status;
  }
}

function adminUrl(config, pathname) {
  const configured = new URL(config.caddyAdminUrl);
  return new URL(pathname, configured.origin);
}

function caddyToken(value) {
  return JSON.stringify(String(value));
}

function renderSite(host, upstream, proxy = {}) {
  const proxyLines = proxy.headerUpHost
    ? [
        `\treverse_proxy ${caddyToken(upstream)} {`,
        `\t\theader_up Host ${caddyToken(proxy.headerUpHost)}`,
        "\t}",
      ]
    : [`\treverse_proxy ${caddyToken(upstream)}`];
  return [
    `${caddyToken(host)} {`,
    "\ttls internal",
    ...proxyLines,
    "}",
  ].join("\n");
}

export function renderCaddyfile(config) {
  const configured = new URL(config.caddyAdminUrl);
  const adminAddress = `${configured.hostname}:${configured.port || "2019"}`;
  const sites = [
    renderSite(
      config.dashboard.host,
      `${config.dashboard.bind}:${config.dashboard.port}`,
    ),
    ...(config.apps ?? []).map((app) => renderSite(app.host, app.upstream, app.proxy)),
  ];
  return [
    "{",
    `\tadmin ${adminAddress}`,
    "}",
    "",
    sites.join("\n\n"),
    "",
  ].join("\n");
}

export async function fetchCaddyState(config) {
  const startedAt = performance.now();
  try {
    const response = await fetch(adminUrl(config, "/config/"), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
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
      error: error instanceof Error ? error.message : "接続できませんでした",
    };
  }
}

export async function syncCaddyConfig(config) {
  let response;
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
      `Caddyへ接続できませんでした: ${error instanceof Error ? error.message : "不明なエラー"}`,
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
