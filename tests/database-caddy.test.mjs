import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderCaddyfile, syncCaddyConfig } from "../dist-server/caddy.js";
import { openLocaldeckStore } from "../dist-server/database.js";
import { createLocaldeckServer } from "../dist-server/http.js";
import { startLocaldeckRuntime } from "../dist-server/runtime.js";

const legacyConfig = {
  version: 1,
  caddyAdminUrl: "http://127.0.0.1:2019/config/",
  dashboard: {
    name: "Localdeck",
    host: "apps.localhost",
    bind: "127.0.0.1",
    port: 4545,
  },
  apps: [
    {
      id: "example",
      name: "Example",
      description: "Legacy app",
      host: "example.localhost",
      upstream: "127.0.0.1:9000",
    },
  ],
};

function normalizedApp(overrides = {}) {
  return {
    id: "example",
    name: "Example",
    description: "",
    host: "example.localhost",
    upstream: "127.0.0.1:9000",
    directory: null,
    requiredEnvironment: [],
    lifecycle: null,
    proxy: {},
    ...overrides,
  };
}

function createFakeStore(initialApps = [normalizedApp()]) {
  let apps = initialApps.map((app) => ({ ...app }));
  const config = () => ({
    version: 1,
    caddyAdminUrl: "http://127.0.0.1:2019/config/",
    dashboard: {
      name: "Localdeck",
      host: "apps.localhost",
      bind: "127.0.0.1",
      port: 4545,
    },
    apps: apps.map((app) => ({ ...app })),
  });
  return {
    getConfig: config,
    listApps: () => config().apps,
    getApp: (id) => apps.find((app) => app.id === id) ?? null,
    createApp: (input) => {
      const app = normalizedApp(input);
      apps.push(app);
      return app;
    },
    updateApp: (id, input) => {
      const index = apps.findIndex((app) => app.id === id);
      if (index < 0) return null;
      apps[index] = { ...apps[index], ...input, id };
      return apps[index];
    },
    deleteApp: (id) => {
      const index = apps.findIndex((app) => app.id === id);
      if (index < 0) return null;
      return apps.splice(index, 1)[0];
    },
    close: () => {},
  };
}

function caddyStateFor(config) {
  return {
    connected: true,
    routes: [
      {
        host: config.dashboard.host,
        server: "srv0",
        upstreams: [`${config.dashboard.bind}:${config.dashboard.port}`],
      },
      ...config.apps.map((app) => ({
        host: app.host,
        server: "srv0",
        upstreams: [app.upstream],
      })),
    ],
    latencyMs: 2,
    error: null,
  };
}

function inspectedApp(app) {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    host: app.host,
    url: `https://${app.host}`,
    directUrl: `http://${app.upstream}`,
    upstream: app.upstream,
    upstreams: app.upstreams,
    port: Number(app.upstream.split(":").at(-1)),
    status: "offline",
    latencyMs: null,
    pid: null,
    uptime: null,
    directory: app.directory,
    configured: true,
    caddyRouteFound: app.caddyRouteFound,
    definition: {
      id: app.id,
      name: app.name,
      description: app.description,
      host: app.host,
      upstream: app.upstream,
      directory: app.directory,
      requiredEnvironment: app.requiredEnvironment,
      lifecycle: app.lifecycle,
      proxy: app.proxy,
    },
    actions: {
      start: { enabled: false, reason: "監視のみ" },
      restart: { enabled: false, reason: "監視のみ" },
      stop: { enabled: false, reason: "監視のみ" },
    },
  };
}

async function createHttpFixture(t, overrides = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "localdeck-http-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staticRoot = path.join(directory, "dist-local");
  await mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await writeFile(
    path.join(staticRoot, "index.html"),
    "<!doctype html><p>Localdeck</p>",
  );
  await writeFile(path.join(staticRoot, "assets", "app.js"), "export {};\n");

  const store = overrides.store ?? createFakeStore();
  const syncCalls = [];
  const actionCalls = [];
  const application = createLocaldeckServer({
    store,
    staticRoot,
    appLogDirectory: path.join(directory, "logs"),
    fetchCaddyState: async (config) => caddyStateFor(config),
    syncCaddyConfig: async (config) => {
      syncCalls.push(config);
    },
    inspectApp: async (app) => inspectedApp(app),
    executeAction: async (app, action) => {
      actionCalls.push({ app: app.id, action });
      return { message: `${app.name} を操作しました`, output: "done" };
    },
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    logger: { error: () => {} },
    ...overrides,
  });
  await new Promise((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    if (!application.server.listening) return;
    await new Promise((resolve, reject) =>
      application.server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = application.server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    syncCalls,
    actionCalls,
    application,
  };
}

test("旧JSONをSQLiteへ一度だけ移行してCRUDを永続化する", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "localdeck-db-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "localdeck.sqlite");
  const legacyConfigPath = path.join(directory, "apps.config.json");
  await writeFile(legacyConfigPath, JSON.stringify(legacyConfig), "utf8");

  const store = await openLocaldeckStore({ databasePath, legacyConfigPath });
  assert.equal(store.listApps().length, 1);
  assert.equal(store.getApp("example").name, "Example");

  store.createApp({
    id: "notes",
    name: "Notes",
    description: "",
    host: "notes.localhost",
    upstream: "127.0.0.1:9100",
    directory: null,
    lifecycle: null,
  });
  assert.equal(store.listApps().length, 2);
  assert.equal(
    store.updateApp("notes", { name: "Local Notes" }).name,
    "Local Notes",
  );
  assert.equal(store.deleteApp("example").id, "example");
  store.close();

  const reopened = await openLocaldeckStore({ databasePath, legacyConfigPath });
  assert.deepEqual(
    reopened.listApps().map((app) => app.id),
    ["notes"],
  );
  reopened.close();
});

test("SQLiteの全アプリとダッシュボードからCaddyfileを生成する", () => {
  const source = renderCaddyfile({
    ...legacyConfig,
    apps: [
      legacyConfig.apps[0],
      {
        id: "proxy-host",
        name: "Proxy Host",
        host: "proxy.localhost",
        upstream: "127.0.0.1:9200",
        proxy: { headerUpHost: "localhost" },
      },
    ],
  });
  assert.match(source, /"apps\.localhost"/);
  assert.match(source, /"example\.localhost"/);
  assert.match(source, /reverse_proxy "127\.0\.0\.1:9000"/);
  assert.match(source, /header_up Host "localhost"/);
  assert.equal((source.match(/tls internal/g) ?? []).length, 3);
});

test("Caddy Admin APIのloadへ全設定を一度で適用する", async (t) => {
  let requestRecord = null;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestRecord = {
      method: request.method,
      url: request.url,
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    };
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await syncCaddyConfig({
    ...legacyConfig,
    caddyAdminUrl: `http://127.0.0.1:${address.port}/config/`,
  });
  assert.equal(requestRecord.method, "POST");
  assert.equal(requestRecord.url, "/load");
  assert.equal(requestRecord.contentType, "text/caddyfile");
  assert.match(requestRecord.body, /"example\.localhost"/);
});

test("HTTP factoryがhealth・snapshot・静的ファイルの公開契約を維持する", async (t) => {
  const fixture = await createHttpFixture(t);
  assert.equal(fixture.application.server.requestTimeout, 130_000);
  assert.equal(fixture.application.server.headersTimeout, 10_000);

  const healthResponse = await fetch(`${fixture.baseUrl}/api/health?detail=1`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    name: "Localdeck",
    host: "apps.localhost",
    now: "2026-08-30T00:00:00.000Z",
  });
  assert.equal(healthResponse.headers.get("cache-control"), "no-store");
  assert.equal(healthResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    healthResponse.headers.get("content-security-policy"),
    /default-src 'self'/,
  );

  const snapshotResponse = await fetch(`${fixture.baseUrl}/api/apps`);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.generatedAt, "2026-08-30T00:00:00.000Z");
  assert.deepEqual(snapshot.summary, { total: 1, online: 0, offline: 1 });
  assert.deepEqual(snapshot.caddy, {
    connected: true,
    routeCount: 1,
    expectedRouteCount: 1,
    totalRouteCount: 2,
    inSync: true,
    latencyMs: 2,
    error: null,
  });
  assert.equal(snapshot.apps[0].definition.id, "example");

  const pageResponse = await fetch(`${fixture.baseUrl}/missing/route`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Localdeck/);
  const assetResponse = await fetch(`${fixture.baseUrl}/assets/app.js`);
  assert.equal(
    assetResponse.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});

test("HTTP factoryがmutation認証・JSON境界・未知APIを公開エラーへ変換する", async (t) => {
  let createCount = 0;
  const store = createFakeStore();
  const originalCreate = store.createApp;
  store.createApp = (input) => {
    createCount += 1;
    return originalCreate(input);
  };
  const fixture = await createHttpFixture(t, { store });

  const denied = await fetch(`${fixture.baseUrl}/api/apps`, {
    method: "POST",
    body: JSON.stringify(
      normalizedApp({ id: "denied", host: "denied.localhost" }),
    ),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    ok: false,
    error: "この操作リクエストは許可されていません",
  });
  assert.equal(createCount, 0);

  const invalidOrigin = await fetch(`${fixture.baseUrl}/api/apps`, {
    method: "POST",
    headers: { "x-localdeck-action": "1", origin: "https://evil.example" },
    body: "{}",
  });
  assert.equal(invalidOrigin.status, 403);
  assert.equal(createCount, 0);

  const invalidJson = await fetch(`${fixture.baseUrl}/api/apps`, {
    method: "POST",
    headers: { "x-localdeck-action": "1" },
    body: "not-json",
  });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), {
    ok: false,
    error: "JSONの形式が不正です",
  });

  const missingApi = await fetch(`${fixture.baseUrl}/api/missing`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), {
    ok: false,
    error: "API が見つかりません",
  });
});

test("HTTP factoryがCRUD・Caddy同期・アプリ操作を注入依存へ委譲する", async (t) => {
  const fixture = await createHttpFixture(t);
  const headers = {
    "content-type": "application/json",
    "x-localdeck-action": "1",
  };
  const notes = normalizedApp({
    id: "notes",
    name: "Notes",
    host: "notes.localhost",
    upstream: "127.0.0.1:9100",
  });

  const created = await fetch(`${fixture.baseUrl}/api/apps`, {
    method: "POST",
    headers,
    body: JSON.stringify(notes),
  });
  assert.equal(created.status, 201);
  assert.match((await created.json()).message, /Notesを登録しました/);

  const updated = await fetch(`${fixture.baseUrl}/api/apps/notes`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "Local Notes" }),
  });
  assert.equal(updated.status, 200);
  assert.match(
    (await updated.json()).message,
    /Local Notesの設定を更新しました/,
  );

  const synchronized = await fetch(`${fixture.baseUrl}/api/caddy/sync`, {
    method: "POST",
    headers: { "x-localdeck-action": "1" },
  });
  assert.equal(synchronized.status, 200);
  assert.match((await synchronized.json()).message, /Caddyへ反映しました/);

  const action = await fetch(`${fixture.baseUrl}/api/apps/notes/start`, {
    method: "POST",
    headers: { "x-localdeck-action": "1" },
  });
  assert.equal(action.status, 200);
  assert.equal((await action.json()).output, "done");
  assert.deepEqual(fixture.actionCalls, [{ app: "notes", action: "start" }]);

  const deleted = await fetch(`${fixture.baseUrl}/api/apps/notes`, {
    method: "DELETE",
    headers: { "x-localdeck-action": "1" },
  });
  assert.equal(deleted.status, 200);
  assert.match(
    (await deleted.json()).message,
    /登録とCaddy routeを削除しました/,
  );
  assert.equal(fixture.store.getApp("notes"), null);
  assert.equal(fixture.syncCalls.length, 5);
});

test("同一アプリの操作ロックを非同期処理より前に取得してDELETEとも競合させない", async (t) => {
  let releaseFirstAction;
  let signalFirstAction;
  let actionCount = 0;
  const firstActionGate = new Promise((resolve) => {
    releaseFirstAction = resolve;
  });
  const firstActionStarted = new Promise((resolve) => {
    signalFirstAction = resolve;
  });
  t.after(() => releaseFirstAction());

  const actionCalls = [];
  const fixture = await createHttpFixture(t, {
    executeAction: async (app, action) => {
      actionCalls.push({ app: app.id, action });
      actionCount += 1;
      if (actionCount === 1) {
        signalFirstAction();
        await firstActionGate;
      }
      return { message: "done", output: "" };
    },
  });
  const headers = { "x-localdeck-action": "1" };
  const firstAction = fetch(`${fixture.baseUrl}/api/apps/example/start`, {
    method: "POST",
    headers,
  });
  await firstActionStarted;

  const competingAction = await fetch(
    `${fixture.baseUrl}/api/apps/example/stop`,
    {
      method: "POST",
      headers,
    },
  );
  assert.equal(competingAction.status, 409);
  assert.deepEqual(await competingAction.json(), {
    ok: false,
    error: "このアプリは別の操作を実行中です",
  });

  const competingDelete = await fetch(`${fixture.baseUrl}/api/apps/example`, {
    method: "DELETE",
    headers,
  });
  assert.equal(competingDelete.status, 409);

  releaseFirstAction();
  assert.equal((await firstAction).status, 200);

  const actionAfterRelease = await fetch(
    `${fixture.baseUrl}/api/apps/example/stop`,
    {
      method: "POST",
      headers,
    },
  );
  assert.equal(actionAfterRelease.status, 200);
  assert.deepEqual(actionCalls, [
    { app: "example", action: "start" },
    { app: "example", action: "stop" },
  ]);
});

test("CRUD後のCaddy同期失敗は成功レスポンスのwarningとして返す", async (t) => {
  const fixture = await createHttpFixture(t, {
    syncCaddyConfig: async () => {
      throw new Error("Caddy unavailable");
    },
  });
  const app = normalizedApp({
    id: "warning",
    name: "Warning",
    host: "warning.localhost",
  });
  const response = await fetch(`${fixture.baseUrl}/api/apps`, {
    method: "POST",
    headers: { "x-localdeck-action": "1" },
    body: JSON.stringify(app),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.warning, "Caddy unavailable");
  assert.match(body.message, /Caddyへの反映に失敗しました/);
  assert.equal(fixture.store.getApp("warning").name, "Warning");
});

test("server indexをimportしてもDB作成やHTTP listenを開始しない", async () => {
  const serverEntry = await import(
    `../dist-server/index.js?test=${Date.now()}`
  );
  const paths = serverEntry.resolveLocaldeckPaths({});
  assert.match(paths.staticRoot, /dist-local$/);
  assert.match(paths.databasePath, /state\/localdeck\.sqlite$/);
});

test("runtimeがlistenからPID・reconcile・冪等shutdownまでを管理する", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "localdeck-runtime-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "state", "localdeck.pid");
  const server = http.createServer((_request, response) => response.end("ok"));
  let synchronizeCount = 0;
  let reconcileCount = 0;
  let closeCount = 0;
  const logs = [];
  const errors = [];
  const application = {
    requestHandler: () => {},
    snapshot: async () => ({}),
    synchronizeCaddy: async () => {
      synchronizeCount += 1;
    },
    reconcileCaddyIfNeeded: async () => {
      reconcileCount += 1;
    },
  };
  const store = {
    close: () => {
      closeCount += 1;
    },
  };
  const config = {
    version: 1,
    caddyAdminUrl: "http://127.0.0.1:2019/config/",
    dashboard: {
      name: "Runtime Test",
      host: "runtime.localhost",
      bind: "127.0.0.1",
      port: 0,
    },
    apps: [],
  };

  const runtime = await startLocaldeckRuntime({
    server,
    application,
    store,
    config,
    pidFile,
    reconcileIntervalMs: 5,
    logger: {
      log: (...items) => logs.push(items),
      error: (...items) => errors.push(items),
    },
  });
  t.after(async () => {
    if (server.listening) await runtime.shutdown("TEST CLEANUP");
  });

  assert.equal(server.listening, true);
  assert.equal(synchronizeCount, 1);
  assert.equal((await readFile(pidFile, "utf8")).trim(), String(process.pid));
  assert.equal(errors.length, 0);

  const reconcileDeadline = Date.now() + 500;
  while (reconcileCount === 0 && Date.now() < reconcileDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(reconcileCount > 0);

  await runtime.shutdown("TEST");
  assert.equal(server.listening, false);
  assert.equal(closeCount, 1);
  await assert.rejects(
    readFile(pidFile, "utf8"),
    (error) => error.code === "ENOENT",
  );
  assert.equal(
    logs.filter(([message]) => message === "TEST: shutting down").length,
    1,
  );

  const reconcilesAfterShutdown = reconcileCount;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reconcileCount, reconcilesAfterShutdown);

  await runtime.shutdown("TEST AGAIN");
  assert.equal(closeCount, 1);
  assert.equal(errors.length, 0);
});

test("runtimeが初期化中のsignalをPID記録後に安全に処理する", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "localdeck-runtime-signal-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "state", "localdeck.pid");
  const server = http.createServer((_request, response) => response.end("ok"));
  const signalSource = new EventEmitter();
  let releasePidWrite;
  let signalPidWriteStarted;
  let synchronizeCount = 0;
  let reconcileCount = 0;
  let closeCount = 0;
  const pidWriteGate = new Promise((resolve) => {
    releasePidWrite = resolve;
  });
  const pidWriteStarted = new Promise((resolve) => {
    signalPidWriteStarted = resolve;
  });
  t.after(() => releasePidWrite());

  const runtimePromise = startLocaldeckRuntime({
    server,
    application: {
      requestHandler: () => {},
      snapshot: async () => ({}),
      synchronizeCaddy: async () => {
        synchronizeCount += 1;
      },
      reconcileCaddyIfNeeded: async () => {
        reconcileCount += 1;
      },
    },
    store: {
      close: () => {
        closeCount += 1;
      },
    },
    config: {
      version: 1,
      caddyAdminUrl: "http://127.0.0.1:2019/config/",
      dashboard: {
        name: "Runtime Signal Test",
        host: "runtime-signal.localhost",
        bind: "127.0.0.1",
        port: 0,
      },
      apps: [],
    },
    pidFile,
    reconcileIntervalMs: 5,
    signalSource,
    writePid: async (targetPidFile) => {
      signalPidWriteStarted();
      await pidWriteGate;
      await mkdir(path.dirname(targetPidFile), { recursive: true });
      await writeFile(targetPidFile, `${process.pid}\n`, { mode: 0o600 });
    },
    logger: { log: () => {}, error: () => {} },
  });

  await pidWriteStarted;
  assert.equal(server.listening, true);
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);
  signalSource.emit("SIGTERM");
  releasePidWrite();

  const runtime = await runtimePromise;
  assert.equal(server.listening, false);
  assert.equal(closeCount, 1);
  assert.equal(synchronizeCount, 0);
  assert.equal(reconcileCount, 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  await assert.rejects(
    readFile(pidFile, "utf8"),
    (error) => error.code === "ENOENT",
  );

  await runtime.shutdown("TEST AGAIN");
  assert.equal(closeCount, 1);
});

test("dashboard polling never requests process metadata; the details endpoint requests it only on demand", async (t) => {
  let detailsReads = 0;
  const fixture = await createHttpFixture(t, {
    inspectApp: async (app, options) => {
      const details = options?.includeProcessDetails === true;
      if (details) detailsReads++;
      return { ...inspectedApp(app), status: "online", port: 9000, pid: details ? 12345 : null, uptime: details ? "01:23" : null };
    },
  });
  for (let poll = 0; poll < 10; poll++) {
    const response = await fetch(`${fixture.baseUrl}/api/apps`);
    assert.equal((await response.json()).apps[0].pid, null);
  }
  assert.equal(detailsReads, 0);
  const response = await fetch(`${fixture.baseUrl}/api/apps/example/details`);
  const details = await response.json();
  assert.equal(details.pid, 12345); assert.equal(details.uptime, "01:23");
  assert.equal(details.processes[0].pid, 12345); assert.ok(details.checkedAt);
  assert.equal(detailsReads, 1);
  for (let poll = 0; poll < 10; poll++) await (await fetch(`${fixture.baseUrl}/api/apps`)).json();
  assert.equal(detailsReads, 1);
  const missing = await fetch(`${fixture.baseUrl}/api/apps/missing/details`);
  assert.equal(missing.status, 404);
});
