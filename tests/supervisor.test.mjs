import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLocaldeckStore } from "../dist-server/database.js";
import {
  normalizeAppDefinition,
  DEFAULT_OPTIONS,
} from "../dist-server/config.js";
import { AppSupervisor, managed } from "../dist-server/supervisor.js";
import { createLocaldeckServer, caddyIsInSync } from "../dist-server/http.js";
import { renderCaddyfile } from "../dist-server/caddy.js";
import { readAppLogs, readAppIcon } from "../dist-server/app-assets.js";

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return server.address().port;
}
async function fixture(t, options = {}, overrides = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "localdeck-supervisor-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openLocaldeckStore({
    databasePath: path.join(directory, "state.sqlite"),
  });
  t.after(() => store.close());
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  store.createApp({
    id: "notes",
    name: "Notes",
    host: "notes.localhost",
    upstream: `127.0.0.1:${port}`,
    directory,
    lifecycle: {
      strategy: "process",
      start: ["fixture", "--port", "{port}"],
      startTimeoutMs: 2000,
      stopTimeoutMs: 2000,
    },
    options: {
      ...DEFAULT_OPTIONS,
      port: { mode: "auto", environment: "WEB_PORT" },
      ...options,
    },
  });
  const online = new Set();
  const calls = [];
  let time = new Date("2026-09-29T10:00:00Z");
  let syncs = 0;
  const inspect = async (app) => ({
    ...app,
    definition: app,
    status: online.has(app.id) ? "online" : "offline",
    port: Number(app.upstream.split(":").at(-1)),
    pid: null,
    actions: {
      start: { enabled: !online.has(app.id), reason: null },
      restart: { enabled: online.has(app.id), reason: null },
      stop: { enabled: online.has(app.id), reason: null },
    },
  });
  const execute = async (app, action, config) => {
    calls.push({ app, action, config });
    if (action === "stop") online.delete(app.id);
    else online.add(app.id);
    return { message: "done", output: "" };
  };
  const supervisor = new AppSupervisor({
    store,
    inspect,
    execute,
    appLogDirectory: directory,
    now: () => time,
    synchronize: async () => {
      syncs++;
    },
    ...overrides,
  });
  return {
    directory,
    store,
    supervisor,
    online,
    calls,
    inspect,
    execute,
    advance: (ms) => {
      time = new Date(time.getTime() + ms);
    },
    syncs: () => syncs,
  };
}
const backend = (id, port) => ({
  id,
  name: id.toUpperCase(),
  directory: "/tmp",
  start: ["fixture", "--listen", `{backendPort:${id}}`],
  port,
  portSettings: { mode: "auto", environment: "API_PORT" },
  environment: {},
});

test("automatic ports avoid occupied ports and keep process arguments, environments and saved routes consistent", async (t) => {
  const occupied = await listen(
    t,
    net.createServer((socket) => socket.end()),
  );
  const f = await fixture(t, {
    backends: [backend("api", occupied)],
    environment: { API_URL: "http://127.0.0.1:{backendPort:api}" },
  });
  f.store.updateApp("notes", { upstream: `127.0.0.1:${occupied}` });
  await f.supervisor.run("notes", "start");
  const saved = f.store.getApp("notes");
  const mainPort = Number(saved.upstream.split(":").at(-1));
  const apiPort = saved.options.backends[0].port;
  assert.notEqual(mainPort, occupied);
  assert.notEqual(apiPort, occupied);
  assert.notEqual(mainPort, apiPort);
  assert.deepEqual(
    f.calls.map((call) => call.app.id),
    ["notes__api", "notes"],
  );
  assert.equal(f.calls[0].app.lifecycle.start.at(-1), String(apiPort));
  assert.equal(f.calls[0].config.environment.API_PORT, String(apiPort));
  assert.equal(f.calls[1].app.lifecycle.start.at(-1), String(mainPort));
  assert.equal(f.calls[1].config.environment.WEB_PORT, String(mainPort));
  assert.equal(
    f.calls[1].config.environment.API_URL,
    `http://127.0.0.1:${apiPort}`,
  );
  assert.equal(saved.lifecycle.start.at(-1), "{port}");
  assert.equal(f.store.getRuntime("notes").phase, "running");
  assert.equal(f.syncs(), 1);
  await f.supervisor.run("notes", "stop");
  assert.deepEqual(
    f.calls.slice(2).map((call) => call.app.id),
    ["notes", "notes__api"],
  );
});

test("a backend failure rolls back only processes started by the operation and persists the error", async (t) => {
  const calls = [];
  const f = await fixture(
    t,
    { backends: [backend("api", 32401), backend("worker", 32402)] },
    {
      execute: async (app, action) => {
        calls.push([app.id, action]);
        if (app.id === "notes__worker" && action === "start")
          throw new Error("worker failed");
        return { message: "ok", output: "" };
      },
    },
  );
  await assert.rejects(f.supervisor.run("notes", "start"), /worker failed/);
  assert.deepEqual(calls, [
    ["notes__api", "start"],
    ["notes__worker", "start"],
    ["notes__api", "stop"],
  ]);
  assert.equal(f.store.getRuntime("notes").phase, "error");
  const reopened = await openLocaldeckStore({
    databasePath: path.join(f.directory, "state.sqlite"),
  });
  assert.equal(reopened.getRuntime("notes").lastError, "worker failed");
  reopened.close();
});

test("simultaneous wake requests share one start, and manual actions cannot race it", async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let count = 0;
  const f = await fixture(
    t,
    { wakeOnRequest: true },
    {
      execute: async (app) => {
        count++;
        entered();
        await gate;
        f.online.add(app.id);
        return { message: "ok", output: "" };
      },
    },
  );
  const first = f.supervisor.wake("notes");
  await started;
  const second = f.supervisor.wake("notes");
  await assert.rejects(f.supervisor.run("notes", "stop"), /別の操作/);
  assert.equal(
    (await f.supervisor.inspect(managed(f.store.getApp("notes")))).runtime
      .phase,
    "starting",
  );
  release();
  await Promise.all([first, second]);
  assert.equal(count, 1);
});

test("idle stop respects active connections, keep-alive and recent activity", async (t) => {
  const f = await fixture(t, { idleStopMinutes: 1, requestOnlyIdle: true });
  await f.supervisor.run("notes", "start");
  const end = f.supervisor.beginRequest("notes");
  f.advance(120_000);
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), true);
  end();
  f.advance(30_000);
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), true);
  f.store.updateApp("notes", {
    options: { ...f.store.getApp("notes").options, keepAlive: true },
  });
  f.advance(120_000);
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), true);
  f.store.updateApp("notes", {
    options: { ...f.store.getApp("notes").options, keepAlive: false },
  });
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), false);
});

test("activity-check failures and busy jobs keep the app running; only busy:false permits stopping", async (t) => {
  let response = "invalid",
    status = 200;
  const port = await listen(
    t,
    http.createServer((_request, res) => {
      res.writeHead(status);
      res.end(response);
    }),
  );
  const f = await fixture(t, { idleStopMinutes: 1, activityPath: "/activity" });
  f.store.updateApp("notes", { upstream: `127.0.0.1:${port}` });
  f.online.add("notes");
  await f.supervisor.inspect(managed(f.store.getApp("notes")));
  f.advance(120_000);
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), true);
  response = '{"busy":true}';
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), true);
  status = 500;
  response = '{"busy":false}';
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), true);
  status = 200;
  await f.supervisor.maintain();
  assert.equal(f.online.has("notes"), false);
});

test("categories, order and options survive reopening without changing the registered commands", async (t) => {
  const f = await fixture(t);
  f.store.saveCategory({ id: "tools", name: "Tools", color: "blue" });
  const original = f.store.getApp("notes");
  f.store.updateApp("notes", {
    options: { ...original.options, categoryId: "tools" },
  });
  f.store.createApp({ ...original, id: "other", host: "other.localhost" });
  f.store.reorderApps(["other", "notes"]);
  assert.throws(() => f.store.reorderApps(["notes", "notes"]));
  const reopened = await openLocaldeckStore({
    databasePath: path.join(f.directory, "state.sqlite"),
  });
  assert.deepEqual(
    reopened.listApps().map((app) => app.id),
    ["other", "notes"],
  );
  assert.deepEqual(reopened.getApp("notes").lifecycle, original.lifecycle);
  assert.equal(reopened.getApp("notes").options.categoryId, "tools");
  reopened.deleteCategory("tools");
  assert.equal(reopened.getApp("notes").options.categoryId, null);
  reopened.close();
});

test("gateway-enabled apps route through Localdeck while direct apps keep their upstream and Host override", () => {
  const app = normalizeAppDefinition({
    id: "notes",
    name: "Notes",
    host: "notes.localhost",
    upstream: "127.0.0.1:3000",
    directory: "/tmp",
    lifecycle: { strategy: "process", start: ["node", "server.js"] },
    proxy: { headerUpHost: "localhost" },
    options: { ...DEFAULT_OPTIONS, wakeOnRequest: true },
  });
  const config = {
    dashboard: { host: "apps.localhost", bind: "127.0.0.1", port: 4545 },
    caddyAdminUrl: "http://127.0.0.1:2019",
    apps: [app],
  };
  const source = renderCaddyfile(config);
  assert.match(source, /notes\.localhost[^]*reverse_proxy "127\.0\.0\.1:4545"/);
  assert.doesNotMatch(source, /header_up Host/);
  assert.equal(
    caddyIsInSync(
      {
        connected: true,
        routes: [
          { host: "apps.localhost", upstreams: ["127.0.0.1:4545"] },
          { host: "notes.localhost", upstreams: ["127.0.0.1:4545"] },
        ],
      },
      config,
    ),
    true,
  );
  app.options.wakeOnRequest = false;
  assert.match(
    renderCaddyfile(config),
    /reverse_proxy "127\.0\.0\.1:3000"[^]*header_up Host "localhost"/,
  );
});

test("gateway forwards app paths, methods, bodies and Host instead of exposing the management API", async (t) => {
  const upstreamPort = await listen(
    t,
    http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          path: request.url,
          host: request.headers.host,
          action: request.headers["x-localdeck-action"],
          method: request.method,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }),
  );
  const f = await fixture(t, { wakeOnRequest: true });
  f.store.updateApp("notes", {
    upstream: `127.0.0.1:${upstreamPort}`,
    proxy: { headerUpHost: "localhost" },
  });
  f.online.add("notes");
  const application = createLocaldeckServer({
    store: f.store,
    staticRoot: f.directory,
    appLogDirectory: f.directory,
    inspectApp: f.inspect,
    fetchCaddyState: async () => ({
      connected: false,
      routes: [],
      latencyMs: null,
      error: null,
    }),
    syncCaddyConfig: async () => {},
    executeAction: f.execute,
  });
  const port = await listen(t, application.server);
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/apps?x=1",
        method: "POST",
        headers: { Host: "notes.localhost", "x-localdeck-action": "1" },
      },
      async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
      },
    );
    request.on("error", reject);
    request.end("payload");
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    path: "/api/apps?x=1",
    host: "localhost",
    method: "POST",
    body: "payload",
  });
  assert.equal(f.store.listApps().length, 1);
});

test("log reads are bounded and backend selection cannot escape the log directory; icons do not start apps", async (t) => {
  const f = await fixture(t, { backends: [backend("api", 32410)] });
  await writeFile(
    path.join(f.directory, "notes.log"),
    "first line\n" + "long log line\n".repeat(20_000) + "last line\n",
  );
  const log = await readAppLogs(f.store.getApp("notes"), f.directory);
  assert.equal(log.truncated, true);
  assert.ok(log.text.length <= 128 * 1024);
  assert.ok(log.text.endsWith("last line\n"));
  await assert.rejects(
    readAppLogs(f.store.getApp("notes"), f.directory, "../../secret"),
  );
  await mkdir(path.join(f.directory, "public"));
  await writeFile(
    path.join(f.directory, "public/favicon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const icon = await readAppIcon(f.store.getApp("notes"));
  assert.equal(icon.type, "image/svg+xml");
  assert.equal(f.calls.length, 0);
});

test("unsafe or inconsistent automation and backend definitions are rejected", async (t) => {
  const f = await fixture(t);
  const app = f.store.getApp("notes");
  assert.throws(
    () =>
      normalizeAppDefinition({
        ...app,
        options: { ...app.options, idleStopMinutes: 10 },
      }),
    /確認パス/,
  );
  assert.throws(
    () =>
      normalizeAppDefinition({
        ...app,
        options: { ...app.options, activityPath: "//evil.example" },
      }),
    /パス/,
  );
  assert.throws(
    () =>
      normalizeAppDefinition({
        ...app,
        options: {
          ...app.options,
          environment: { API_URL: "{backendPort:missing}" },
        },
      }),
    /登録されていません/,
  );
  assert.throws(
    () =>
      normalizeAppDefinition({
        ...app,
        options: {
          ...app.options,
          backends: [backend("api", 8000), backend("api", 8001)],
        },
      }),
    /重複/,
  );
});

test(
  "WebSocket upgrades preserve both directions and prevent idle stop until disconnected",
  { timeout: 5000 },
  async (t) => {
    const peers = new Set();
    const upstream = http.createServer();
    upstream.on("upgrade", (_request, socket, head) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => peers.delete(socket));
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello",
      );
      if (head.length) socket.write(head);
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("end", () => socket.end());
    });
    t.after(() => {
      for (const peer of peers) peer.destroy();
    });
    const upstreamPort = await listen(t, upstream);
    const f = await fixture(t, {
      wakeOnRequest: true,
      idleStopMinutes: 1,
      requestOnlyIdle: true,
    });
    f.store.updateApp("notes", { upstream: `127.0.0.1:${upstreamPort}` });
    f.online.add("notes");
    let now = new Date("2026-09-29T10:00:00Z");
    const application = createLocaldeckServer({
      store: f.store,
      staticRoot: f.directory,
      appLogDirectory: f.directory,
      inspectApp: f.inspect,
      executeAction: f.execute,
      fetchCaddyState: async () => ({
        connected: false,
        routes: [],
        latencyMs: null,
        error: null,
      }),
      syncCaddyConfig: async () => {},
      now: () => now,
    });
    const port = await listen(t, application.server);
    t.after(() => application.dispose());
    const socket = net.createConnection({ host: "127.0.0.1", port });
    t.after(() => socket.destroy());
    let buffer = "";
    const echoed = new Promise((resolve, reject) => {
      socket.on("error", reject);
      socket.setTimeout(2000, () => reject(new Error("upgrade timed out")));
      socket.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("helloearly")) resolve();
      });
    });
    socket.write(
      "GET /hmr HTTP/1.1\r\nHost: notes.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nearly",
    );
    await echoed;
    assert.match(buffer, /101 Switching Protocols/);
    now = new Date(now.getTime() + 120_000);
    await application.maintain();
    assert.equal(f.online.has("notes"), true);
    assert.equal(
      (await application.snapshot()).apps[0].runtime.activeRequests,
      1,
    );
    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.destroy();
    });
    // Let the peer-close event release the gateway's active request.
    for (
      let i = 0;
      i < 20 && (await application.snapshot()).apps[0].runtime.activeRequests;
      i++
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (await application.snapshot()).apps[0].runtime.activeRequests,
      0,
    );
    now = new Date(now.getTime() + 120_000);
    await application.maintain();
    assert.equal(f.online.has("notes"), false);
  },
);

test("a real app group receives distinct ports, serves through the gateway and cleans up all processes", async (t) => {
  const { executeAction, inspectApp } = await import(
    "../dist-server/process-manager.js"
  );
  const f = await fixture(t);
  const mainFile = path.join(f.directory, "main.cjs"),
    apiFile = path.join(f.directory, "api.cjs");
  await writeFile(
    apiFile,
    'require("node:http").createServer((q,s)=>s.end("api-ready")).listen(Number(process.env.API_PORT),"127.0.0.1");',
  );
  await writeFile(
    mainFile,
    'require("node:http").createServer(async(q,s)=>{const response=await fetch(process.env.API_URL);s.end(await response.text());}).listen(Number(process.env.WEB_PORT),"127.0.0.1");',
  );
  const original = f.store.getApp("notes");
  f.store.updateApp("notes", {
    lifecycle: { ...original.lifecycle, start: [process.execPath, mainFile] },
    options: {
      ...original.options,
      wakeOnRequest: true,
      environment: { API_URL: "http://127.0.0.1:{backendPort:api}" },
      backends: [
        {
          ...backend("api", 32511),
          directory: f.directory,
          start: [process.execPath, apiFile],
        },
      ],
    },
  });
  const application = createLocaldeckServer({
    store: f.store,
    staticRoot: f.directory,
    appLogDirectory: f.directory,
    inspectApp,
    executeAction,
    fetchCaddyState: async () => ({
      connected: false,
      routes: [],
      latencyMs: null,
      error: null,
    }),
    syncCaddyConfig: async () => {},
  });
  const port = await listen(t, application.server);
  const cleanupDefinition = f.store.getApp("notes");
  t.after(async () => {
    const app = cleanupDefinition;
    const { backendApp } = await import("../dist-server/supervisor.js");
    for (const target of [
      managed(app),
      ...app.options.backends.map((b) => backendApp(app, b)),
    ])
      await executeAction(target, "stop", {
        appLogDirectory: f.directory,
      }).catch(() => {});
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        headers: { Host: "notes.localhost" },
      },
      async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString(),
        });
      },
    );
    request.on("error", reject);
  });
  assert.deepEqual(response, { status: 200, text: "api-ready" });
  const snapshot = await application.snapshot();
  assert.equal(snapshot.apps[0].runtime.phase, "running");
  assert.equal(
    snapshot.apps[0].runtime.processes.filter((p) => p.online).length,
    2,
  );
  const stop = await fetch(`http://127.0.0.1:${port}/api/apps/notes/stop`, {
    method: "POST",
    headers: { "x-localdeck-action": "1" },
  });
  assert.equal(stop.status, 200);
  assert.equal(
    (await stop.json()).snapshot.apps[0].runtime.processes.some(
      (p) => p.online,
    ),
    false,
  );
});

test("the version-1 database migrates without losing existing app settings or order", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "localdeck-migration-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await openLocaldeckStore({ databasePath });
  store.createApp({
    id: "existing",
    name: "Existing",
    host: "existing.localhost",
    upstream: "127.0.0.1:5173",
    directory: "/tmp",
    lifecycle: { strategy: "process", start: ["bin/dev"] },
  });
  const before = store.getApp("existing");
  store.close();
  const oldDatabase = new DatabaseSync(databasePath);
  oldDatabase.exec(
    "ALTER TABLE apps DROP COLUMN options_json; ALTER TABLE apps DROP COLUMN runtime_json; DROP TABLE categories; PRAGMA user_version = 1;",
  );
  oldDatabase.close();
  store = await openLocaldeckStore({ databasePath });
  assert.deepEqual(store.getApp("existing"), before);
  assert.deepEqual(store.listCategories(), []);
  assert.equal(store.getRuntime("existing"), null);
  store.close();
});

test("configuration locks prevent start/delete races and shutdown waits for operations", async (t) => {
  const f = await fixture(t);
  const unlock = f.supervisor.lockConfiguration("notes");
  await assert.rejects(f.supervisor.run("notes", "start"), /別の操作/);
  assert.throws(() => f.supervisor.lockConfiguration("notes"), /別の操作/);
  unlock();
  await f.supervisor.run("notes", "start");
  await f.supervisor.dispose();
  await assert.rejects(f.supervisor.run("notes", "stop"), /別の操作/);
});

test("adding metadata to a legacy fixed-port app does not introduce a PORT environment override", async (t) => {
  const f = await fixture(t, { port: DEFAULT_OPTIONS.port });
  await f.supervisor.run("notes", "start");
  assert.equal(Object.hasOwn(f.calls[0].config.environment, "PORT"), false);
  assert.equal(Object.hasOwn(f.calls[0].config.environment, ""), false);
});

test("Caddy synchronization failures keep the started process running and surface a warning", async (t) => {
  const f = await fixture(
    t,
    {},
    {
      synchronize: async () => {
        throw new Error("Caddy offline");
      },
    },
  );
  const result = await f.supervisor.run("notes", "start");
  assert.equal(result.warning, "Caddy offline");
  assert.equal(f.online.has("notes"), true);
  assert.equal(f.store.getRuntime("notes").phase, "running");
});

test("gateway traffic and idle checks use TCP health without PID or uptime scans", async (t) => {
  const inspections = [];
  const f = await fixture(t, { wakeOnRequest: true, idleStopMinutes: 1, requestOnlyIdle: true }, {
    inspect: async (app, options) => {
      inspections.push(options);
      return { ...app, status: "online", port: Number(app.upstream.split(":").at(-1)), pid: null, definition: app, actions: {} };
    },
  });
  for (let request = 0; request < 50; request++) await f.supervisor.wake("notes");
  await f.supervisor.inspect(managed(f.store.getApp("notes")), { includeProcessDetails: false });
  f.advance(120_000); await f.supervisor.maintain();
  assert.ok(inspections.length >= 52);
  assert.ok(inspections.every((options) => options?.includeProcessDetails === false));
});
