import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  executeAction,
  extractCaddyRoutes,
  isPortOpen,
  mergeConfiguredApps,
  parseUpstream,
  validateConfig,
} from "../server/core.mjs";

const execFileAsync = promisify(execFile);

const caddyFixture = {
  apps: {
    http: {
      servers: {
        srv0: {
          routes: [
            {
              match: [{ host: ["symphony.localhost"] }],
              handle: [
                {
                  handler: "subroute",
                  routes: [
                    {
                      handle: [
                        {
                          handler: "reverse_proxy",
                          upstreams: [{ dial: "127.0.0.1:14000" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              match: [{ host: ["notes.localhost"] }],
              handle: [
                {
                  handler: "reverse_proxy",
                  upstreams: [{ dial: "127.0.0.1:9000" }],
                },
              ],
            },
          ],
        },
      },
    },
  },
};

const configFixture = {
  version: 1,
  dashboard: { host: "apps.localhost", port: 4545 },
  apps: [
    {
      id: "symphony",
      name: "Symphony",
      host: "symphony.localhost",
      upstream: "127.0.0.1:14000",
    },
  ],
};

test("ネストされた Caddy reverse_proxy をホスト単位で抽出する", () => {
  assert.deepEqual(extractCaddyRoutes(caddyFixture), [
    { host: "notes.localhost", server: "srv0", upstreams: ["127.0.0.1:9000"] },
    { host: "symphony.localhost", server: "srv0", upstreams: ["127.0.0.1:14000"] },
  ]);
});

test("SQLiteで登録したアプリだけをCaddyの状態と統合する", () => {
  const apps = mergeConfiguredApps(extractCaddyRoutes(caddyFixture), configFixture);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, "symphony");
  assert.equal(apps[0].configured, true);
  assert.equal(apps[0].caddyRouteFound, true);
});

test("upstream の IPv4・ホスト名・IPv6 を検証する", () => {
  assert.deepEqual(parseUpstream("127.0.0.1:8765"), { address: "127.0.0.1", port: 8765 });
  assert.deepEqual(parseUpstream("localhost:3000"), { address: "localhost", port: 3000 });
  assert.deepEqual(parseUpstream("[::1]:4545"), { address: "::1", port: 4545 });
  assert.equal(parseUpstream("invalid"), null);
  assert.equal(parseUpstream("localhost:99999"), null);
});

test("重複 ID と不正な upstream を設定時に拒否する", () => {
  assert.throws(
    () => validateConfig({ ...configFixture, apps: [...configFixture.apps, configFixture.apps[0]] }),
    /重複/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...configFixture,
        apps: [{ ...configFixture.apps[0], upstream: "not-a-port" }],
      }),
    /upstream/,
  );
});

test("TCP ポートの online/offline を読み取る", async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const online = await isPortOpen("127.0.0.1", address.port);
  assert.equal(online.online, true);
  assert.ok(online.latencyMs >= 1);

  await new Promise((resolve) => server.close(resolve));
  const offline = await isPortOpen("127.0.0.1", address.port);
  assert.equal(offline.online, false);
  assert.equal(offline.latencyMs, null);
});

test("process 方式は登録ディレクトリのプロセスを起動して安全に停止する", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "localdeck-test-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));

  const app = {
    id: "test-process",
    name: "Test Process",
    host: "test.localhost",
    upstream: `127.0.0.1:${port}`,
    upstreams: [`127.0.0.1:${port}`],
    directory: temporaryDirectory,
    configured: true,
    lifecycle: {
      strategy: "process",
      start: [
        process.execPath,
        "-e",
        `require('node:net').createServer(() => {}).listen(${port}, '127.0.0.1')`,
      ],
      logFile: path.join(temporaryDirectory, "process.log"),
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
    },
  };

  await executeAction(app, "start");
  assert.equal((await isPortOpen("127.0.0.1", port)).online, true);

  await executeAction(app, "stop");
  assert.equal((await isPortOpen("127.0.0.1", port)).online, false);
});

test("Localdeck の起動プロセスを呼び出し元とは別セッションへ切り離す", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "localdeck-detached-test-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));

  const workerFile = path.join(temporaryDirectory, "worker.mjs");
  const logFile = path.join(temporaryDirectory, "worker.log");
  await writeFile(
    workerFile,
    `import net from "node:net";\nnet.createServer(() => {}).listen(${port}, "127.0.0.1");\n`,
  );

  const launcherFile = new URL("../server/start-detached.mjs", import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    launcherFile.pathname,
    workerFile,
    temporaryDirectory,
    logFile,
  ]);
  const pid = Number(stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1);

  t.after(async () => {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  });

  assert.doesNotThrow(() => process.kill(-pid, 0));

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await isPortOpen("127.0.0.1", port)).online) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await isPortOpen("127.0.0.1", port)).online, true);
});
