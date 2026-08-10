import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderCaddyfile, syncCaddyConfig } from "../server/caddy.mjs";
import { openLocaldeckStore } from "../server/database.mjs";

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
  assert.equal(store.updateApp("notes", { name: "Local Notes" }).name, "Local Notes");
  assert.equal(store.deleteApp("example").id, "example");
  store.close();

  const reopened = await openLocaldeckStore({ databasePath, legacyConfigPath });
  assert.deepEqual(reopened.listApps().map((app) => app.id), ["notes"]);
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
