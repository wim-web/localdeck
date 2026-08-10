import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("Localdeck の管理画面をローカル向けにbuildする", async () => {
  const [html, page] = await Promise.all([
    readFile(new URL("../dist-local/index.html", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<html[^>]*lang="ja"/i);
  assert.match(html, /<title>Localdeck — ローカルアプリ管制室<\/title>/i);
  assert.match(html, /\/assets\/index-[^"']+\.js/);
  assert.match(page, /fetch\("\/api\/apps"/);
  assert.match(page, /アプリを登録/);
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
