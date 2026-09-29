// In-memory UI fixture. This does not start Localdeck, Caddy, or managed apps.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(process.argv[2]);
let categories = [
  { id: "research", name: "リサーチ", color: "purple" },
  { id: "creative", name: "クリエイティブ", color: "blue" },
];
let apps = [
  [
    "ai-ultra",
    "AI Ultra Research",
    "AI業界の動きを、調査・蓄積・検索するアーカイブ",
    5173,
    "research",
    "running",
  ],
  [
    "busbar",
    "Busbar",
    "SEC提出資料と公式IRを集めるローカルトラッカー",
    4310,
    "research",
    "stopped",
  ],
  [
    "idem",
    "idem",
    "キャラクターの一貫性を保ちながら、アイデアを画像に",
    5174,
    "creative",
    "running",
  ],
].map(([id, name, description, port, categoryId, phase]) => ({
  definition: {
    id,
    name,
    description,
    host: `${id}.localhost`,
    upstream: `127.0.0.1:${port}`,
    directory: `/Users/you/projects/${id}`,
    requiredEnvironment: [],
    lifecycle: {
      strategy: "process",
      start: ["npm", "run", "dev", "--", "--port", "{port}"],
      startTimeoutMs: 120000,
      stopTimeoutMs: 15000,
    },
    proxy: {},
    options: {
      categoryId,
      port: { mode: "auto", environment: "PORT" },
      environment: {},
      backends: [],
      wakeOnRequest: true,
      idleStopMinutes: 0,
      activityPath: "",
      requestOnlyIdle: false,
      keepAlive: false,
    },
  },
  phase,
}));
function snapshot() {
  const views = apps.map(({ definition: d, phase }) => ({
    ...d,
    definition: d,
    url: `https://${d.host}`,
    directUrl: `http://${d.upstream}`,
    upstreams: [d.upstream],
    port: Number(d.upstream.split(":").at(-1)),
    status: phase === "running" ? "online" : "offline",
    pid: phase === "running" ? 23450 : null,
    uptime: phase === "running" ? "02:18:43" : null,
    latencyMs: phase === "running" ? 3 : null,
    configured: true,
    caddyRouteFound: true,
    actions: {
      start: {
        enabled: phase !== "running",
        reason: phase === "running" ? "起動中です" : null,
      },
      stop: { enabled: phase === "running", reason: null },
      restart: { enabled: phase === "running", reason: null },
    },
    runtime: {
      phase,
      changedAt: new Date().toISOString(),
      lastError: null,
      activeRequests: 0,
      idleReason: null,
      idleUntil: null,
      processes: [
        {
          id: "main",
          name: "メイン",
          port: Number(d.upstream.split(":").at(-1)),
          online: phase === "running",
          pid: phase === "running" ? 23450 : null,
        },
      ],
    },
  }));
  return {
    generatedAt: new Date().toISOString(),
    categories,
    caddy: {
      connected: true,
      routeCount: apps.length,
      expectedRouteCount: apps.length,
      totalRouteCount: apps.length + 1,
      inSync: true,
      latencyMs: 2,
      error: null,
    },
    summary: {
      total: apps.length,
      online: views.filter((v) => v.status === "online").length,
      offline: views.filter((v) => v.status !== "online").length,
    },
    apps: views,
  };
}
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  function json(value) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(value));
  }
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname.endsWith("/favicon")) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (url.pathname.endsWith("/details")) {
      const app = snapshot().apps.find(
        (app) => app.id === url.pathname.split("/")[3],
      );
      json({
        pid: app?.pid ?? null,
        uptime: app?.uptime ?? null,
        processes: app?.runtime.processes ?? [],
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    if (url.pathname.endsWith("/logs")) {
      json({
        text: "[UI preview fixture]\nVITE ready in 218 ms\nLocal server ready\nGET /api/health 200\n",
        bytes: 90,
        truncated: false,
      });
      return;
    }
    if (request.method === "GET") {
      json(snapshot());
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    const app = apps.find(
      (app) => url.pathname.split("/")[3] === app.definition.id,
    );
    if (url.pathname === "/api/apps/reorder")
      apps = body.ids.map((id) => apps.find((app) => app.definition.id === id));
    else if (url.pathname === "/api/categories") {
      categories = categories.filter((c) => c.id !== body.id).concat(body);
    } else if (
      url.pathname.startsWith("/api/categories/") &&
      request.method === "DELETE"
    ) {
      const id = url.pathname.split("/")[3];
      categories = categories.filter((c) => c.id !== id);
      apps.forEach((app) => {
        if (app.definition.options.categoryId === id)
          app.definition.options.categoryId = null;
      });
    } else if (app && /\/(start|restart|stop)$/.test(url.pathname))
      app.phase = url.pathname.endsWith("/stop") ? "stopped" : "running";
    else if (app && url.pathname.endsWith("/keep-alive"))
      app.definition.options.keepAlive = body.enabled;
    else if (app && request.method === "PUT") app.definition = body;
    else if (app && request.method === "DELETE")
      apps = apps.filter((item) => item !== app);
    else if (url.pathname === "/api/apps")
      apps.push({ definition: body, phase: "stopped" });
    json({ ok: true, message: "Preview updated", snapshot: snapshot() });
    return;
  }
  let filename = path.resolve(root, "." + url.pathname);
  if (!filename.startsWith(root + path.sep))
    filename = path.join(root, "index.html");
  try {
    const body = await readFile(filename);
    const mime = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".html": "text/html",
    };
    response.setHeader(
      "Content-Type",
      mime[path.extname(filename)] ?? "application/octet-stream",
    );
    response.end(body);
  } catch {
    response.setHeader("Content-Type", "text/html");
    response.end(await readFile(path.join(root, "index.html")));
  }
});
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  server.listen(0, "127.0.0.1", () =>
    console.log(`UI fixture: http://127.0.0.1:${server.address().port}`),
  );
