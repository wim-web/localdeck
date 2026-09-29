import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createServer as createViteServer } from "vite";

test("Localdeck の管理画面をローカル向けにbuildする", async () => {
  const [html, favicon, page, api, editor] = await Promise.all([
    readFile(new URL("../dist-local/index.html", import.meta.url), "utf8"),
    readFile(new URL("../local/favicon.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/localdeck-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/app-editor.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<html[^>]*lang="ja"/i);
  assert.match(html, /<title>Localdeck — ローカルアプリ管制室<\/title>/i);
  assert.match(html, /<link[^>]*rel="icon"[^>]*href="\/assets\/favicon-[^"']+\.svg"/i);
  assert.match(favicon, /<title>Localdeck<\/title>/i);
  assert.match(html, /\/assets\/index-[^"']+\.js/);
  assert.match(api, /fetch\("\/api\/apps"/);
  assert.match(editor, /アプリを登録/);
  assert.match(page, /useLocaldeckController/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
});

test("ホスティング用スターターを含めない", async () => {
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");

  await Promise.all([
    assert.rejects(access(new URL("../.openai/hosting.json", import.meta.url))),
    assert.rejects(access(new URL("../app/chatgpt-auth.ts", import.meta.url))),
    assert.rejects(access(new URL("../worker/index.ts", import.meta.url))),
  ]);
  assert.doesNotMatch(
    packageJson,
    /cloudflare|chatgpt|next|tailwind|vinext|wrangler/i,
  );
});

test("自動更新の多重起動とコマンド選択の競合を防ぐ", async (t) => {
  const vite = await createViteServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  t.after(() => vite.close());

  const [{ SnapshotRequestGate }, selection, commandItems] = await Promise.all([
    vite.ssrLoadModule("/app/snapshot-request-gate.ts"),
    vite.ssrLoadModule("/app/command-selection.ts"),
    vite.ssrLoadModule("/app/command-items.ts"),
  ]);

  const gate = new SnapshotRequestGate();
  const slowRefresh = gate.start(true);
  assert.equal(typeof slowRefresh, "number");
  assert.equal(gate.start(true), null);
  assert.equal(gate.isCurrent(slowRefresh), true);

  const manualRefresh = gate.start(false);
  assert.equal(gate.isCurrent(slowRefresh), false);
  assert.equal(gate.isCurrent(manualRefresh), true);
  gate.finish(manualRefresh);
  const nextQuietRefresh = gate.start(true);
  assert.equal(typeof nextQuietRefresh, "number");
  assert.equal(gate.isCurrent(nextQuietRefresh), true);
  gate.finish(slowRefresh);
  gate.finish(nextQuietRefresh);

  const reorderedCommands = [
    { id: "register", disabled: false },
    { id: "another-action", disabled: false },
    { id: "example-stop", disabled: false },
  ];
  assert.equal(
    selection.resolveActiveCommandId(reorderedCommands, "example-stop"),
    "example-stop",
  );
  assert.equal(
    selection.resolveActiveCommandId(reorderedCommands.slice(0, 2), "example-stop"),
    "register",
  );

  const app = {
    id: "example",
    name: "Example",
    host: "example.localhost",
    url: "https://example.localhost",
    status: "online",
    actions: {
      start: { enabled: false, reason: "稼働中" },
      restart: { enabled: true, reason: null },
      stop: { enabled: true, reason: null },
    },
  };
  const commands = commandItems.createCommandItems({
    snapshot: {
      caddy: { connected: true, inSync: true },
      apps: [app, { ...app, id: "other", name: "Other", host: "other.localhost" }],
    },
    refreshing: false,
    autoRefresh: true,
    busyAppIds: new Set(),
    pendingDeleteAppId: "example",
    onRegister() {},
    onRefresh() {},
    onAutoRefreshChange() {},
    onCaddySync() {},
    onCopy() {},
    onEdit() {},
    onAction() {},
    onDelete() {},
  });
  assert.equal(commands.some((command) => command.id.startsWith("example-")), false);
  assert.equal(commands.find((command) => command.id === "other-delete").disabled, true);
});

test("commands and multi-process settings round-trip through the editor", async (t) => {
  const vite = await createViteServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  t.after(() => vite.close());
  const { commandToText, textToCommand, definitionToForm, formToDefinition } = await vite.ssrLoadModule("/app/app-form.ts");
  const command = ["node", "/a path/server.js", "--label", 'a "quoted" value', "--port", "{port}"];
  assert.deepEqual(textToCommand(commandToText(command)), command);
  assert.throws(() => textToCommand('node "unclosed'), /引用符/);
  const app = { id: "test", name: "Test", description: "", host: "test.localhost", upstream: "127.0.0.1:5000", directory: "/tmp", requiredEnvironment: ["API_KEY"], lifecycle: { strategy: "process", start: command, startTimeoutMs: 30000, stopTimeoutMs: 15000 }, proxy: {},
    options: { categoryId: "tools", port: { mode: "auto", environment: "WEB_PORT" }, environment: { API_URL: "http://127.0.0.1:{backendPort:api}" }, backends: [{ id: "api", name: "API", directory: "/tmp/api", start: ["node", "index.js"], port: 8080, portSettings: { mode: "auto", environment: "PORT" }, environment: { DEBUG: "yes" } }], wakeOnRequest: true, idleStopMinutes: 10, activityPath: "/activity", requestOnlyIdle: false, keepAlive: true } };
  assert.deepEqual(formToDefinition(definitionToForm(app)), app);
});
