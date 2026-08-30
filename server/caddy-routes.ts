import type { CaddyRoute, LocaldeckConfig, ManagedApp } from "./types.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectHosts(route: unknown): string[] {
  const hosts = new Set<string>();
  if (!isRecord(route) || !Array.isArray(route.match)) return [];
  for (const matcher of route.match) {
    if (!isRecord(matcher) || !Array.isArray(matcher.host)) continue;
    for (const host of matcher.host) {
      if (typeof host === "string" && host.trim()) hosts.add(host.trim());
    }
  }
  return [...hosts];
}

function collectUpstreams(value: unknown, upstreams = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return upstreams;

  if (isRecord(value) && value.handler === "reverse_proxy" && Array.isArray(value.upstreams)) {
    for (const upstream of value.upstreams) {
      if (isRecord(upstream) && typeof upstream.dial === "string" && upstream.dial.trim()) {
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

export function extractCaddyRoutes(config: unknown): CaddyRoute[] {
  const found = new Map<string, CaddyRoute>();
  if (!isRecord(config) || !isRecord(config.apps)) return [];
  const http = config.apps.http;
  if (!isRecord(http) || !isRecord(http.servers)) return [];

  for (const [serverName, server] of Object.entries(http.servers)) {
    if (!isRecord(server) || !Array.isArray(server.routes)) continue;
    for (const route of server.routes) {
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

export function mergeConfiguredApps(
  routes: CaddyRoute[],
  config: LocaldeckConfig,
): ManagedApp[] {
  const routeByHost = new Map(routes.map((route) => [route.host, route]));
  return config.apps.map((app) => {
    const route = routeByHost.get(app.host);
    return {
      ...app,
      configured: true,
      caddyRouteFound: Boolean(route),
      upstreams: app.upstream ? [app.upstream] : [],
    };
  });
}
