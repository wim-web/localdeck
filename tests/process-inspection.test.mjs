import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import test from "node:test";
import { inspectApp } from "../dist-server/process-manager.js";

test("normal monitoring launches no OS commands; explicit details query runs lsof and ps once", async (t) => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const app = {
    id: "fixture",
    name: "Fixture",
    description: "",
    host: "fixture.localhost",
    upstream: `127.0.0.1:${port}`,
    upstreams: [`127.0.0.1:${port}`],
    directory: null,
    requiredEnvironment: [],
    lifecycle: null,
    proxy: {},
    configured: true,
    caddyRouteFound: true,
  };
  const commands = [];
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (command, ...args) {
    commands.push(command);
    return originalSpawn.call(this, command, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });

  for (let poll = 0; poll < 20; poll++) {
    const view = await inspectApp(app);
    assert.equal(view.status, "online");
    assert.equal(view.pid, null);
    assert.equal(view.uptime, null);
  }
  assert.deepEqual(commands, []);
  const details = await inspectApp(app, { includeProcessDetails: true });
  assert.equal(details.pid, process.pid);
  assert.deepEqual(commands, ["lsof", "ps"]);
  for (let poll = 0; poll < 20; poll++) await inspectApp(app);
  assert.deepEqual(commands, ["lsof", "ps"]);
});
