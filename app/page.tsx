import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

type ActionName = "start" | "restart" | "stop";

type ActionAvailability = {
  enabled: boolean;
  reason: string | null;
};

type LifecycleDefinition =
  | {
      strategy: "commands";
      start: string[] | null;
      restart: string[] | null;
      stop: string[] | null;
      timeoutMs: number;
    }
  | {
      strategy: "process";
      start: string[];
      logFile: string;
      startTimeoutMs: number;
      stopTimeoutMs: number;
    }
  | null;

type AppDefinition = {
  id: string;
  name: string;
  description: string;
  host: string;
  upstream: string;
  directory: string | null;
  requiredEnvironment: string[];
  lifecycle: LifecycleDefinition;
  proxy: { headerUpHost?: string };
};

type LocalApp = {
  id: string;
  name: string;
  description: string;
  host: string;
  url: string;
  directUrl: string | null;
  upstream: string | null;
  port: number | null;
  status: "online" | "offline" | "unknown";
  latencyMs: number | null;
  pid: number | null;
  uptime: string | null;
  directory: string | null;
  configured: boolean;
  caddyRouteFound: boolean;
  definition: AppDefinition;
  actions: Record<ActionName, ActionAvailability>;
};

type Snapshot = {
  generatedAt: string;
  caddy: {
    connected: boolean;
    routeCount: number;
    expectedRouteCount: number;
    totalRouteCount: number;
    inSync: boolean;
    latencyMs: number | null;
    error: string | null;
  };
  summary: {
    total: number;
    online: number;
    offline: number;
  };
  apps: LocalApp[];
};

type ActionResponse = {
  ok: boolean;
  message?: string;
  error?: string;
  output?: string;
  warning?: string | null;
  snapshot?: Snapshot;
};

type FormState = {
  id: string;
  name: string;
  description: string;
  host: string;
  upstream: string;
  directory: string;
  requiredEnvironment: string;
  strategy: "none" | "commands" | "process";
  startCommand: string;
  restartCommand: string;
  stopCommand: string;
  logFile: string;
  timeoutMs: string;
  startTimeoutMs: string;
  stopTimeoutMs: string;
  headerUpHost: string;
};

const REFRESH_INTERVAL_MS = 5_000;

const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  description: "",
  host: "",
  upstream: "127.0.0.1:",
  directory: "",
  requiredEnvironment: "",
  strategy: "none",
  startCommand: "",
  restartCommand: "",
  stopCommand: "",
  logFile: "",
  timeoutMs: "120000",
  startTimeoutMs: "30000",
  stopTimeoutMs: "15000",
  headerUpHost: "",
};

function commandToText(command?: string[] | null) {
  return command?.join("\n") ?? "";
}

function textToCommand(value: string) {
  const args = value.split("\n").map((item) => item.trim()).filter(Boolean);
  return args.length ? args : null;
}

function definitionToForm(app: AppDefinition): FormState {
  const lifecycle = app.lifecycle;
  return {
    ...EMPTY_FORM,
    id: app.id,
    name: app.name,
    description: app.description,
    host: app.host,
    upstream: app.upstream,
    directory: app.directory ?? "",
    requiredEnvironment: app.requiredEnvironment.join(", "),
    strategy: lifecycle?.strategy ?? "none",
    startCommand: commandToText(lifecycle?.start),
    restartCommand: lifecycle?.strategy === "commands" ? commandToText(lifecycle.restart) : "",
    stopCommand: lifecycle?.strategy === "commands" ? commandToText(lifecycle.stop) : "",
    logFile: lifecycle?.strategy === "process" ? lifecycle.logFile : "",
    timeoutMs: lifecycle?.strategy === "commands" ? String(lifecycle.timeoutMs) : "120000",
    startTimeoutMs:
      lifecycle?.strategy === "process" ? String(lifecycle.startTimeoutMs) : "30000",
    stopTimeoutMs:
      lifecycle?.strategy === "process" ? String(lifecycle.stopTimeoutMs) : "15000",
    headerUpHost: app.proxy.headerUpHost ?? "",
  };
}

function formToDefinition(form: FormState): AppDefinition {
  let lifecycle: LifecycleDefinition = null;
  if (form.strategy === "commands") {
    lifecycle = {
      strategy: "commands",
      start: textToCommand(form.startCommand),
      restart: textToCommand(form.restartCommand),
      stop: textToCommand(form.stopCommand),
      timeoutMs: Number(form.timeoutMs),
    };
  } else if (form.strategy === "process") {
    lifecycle = {
      strategy: "process",
      start: textToCommand(form.startCommand) ?? [],
      logFile: form.logFile,
      startTimeoutMs: Number(form.startTimeoutMs),
      stopTimeoutMs: Number(form.stopTimeoutMs),
    };
  }
  return {
    id: form.id,
    name: form.name,
    description: form.description,
    host: form.host,
    upstream: form.upstream,
    directory: form.directory || null,
    requiredEnvironment: form.requiredEnvironment
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter(Boolean),
    lifecycle,
    proxy: form.headerUpHost ? { headerUpHost: form.headerUpHost } : {},
  };
}

function formatCheckedAt(value?: string) {
  if (!value) return "未取得";
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function shortenPath(value: string | null) {
  if (!value) return "—";
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function actionLabel(action: ActionName) {
  if (action === "start") return "起動";
  if (action === "restart") return "再起動";
  return "停止";
}

function statusLabel(status: LocalApp["status"]) {
  if (status === "online") return "稼働中";
  if (status === "offline") return "停止中";
  return "不明";
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function AppEditor({
  form,
  editing,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: FormState;
  editing: boolean;
  saving: boolean;
  onChange: (field: keyof FormState, value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="app-editor" onSubmit={onSubmit}>
      <div className="editor-heading">
        <div>
          <span className="section-kicker">{editing ? "EDIT APP" : "NEW APP"}</span>
          <h3>{editing ? `${form.name}の設定` : "アプリを登録"}</h3>
          <p>保存するとSQLiteとCaddy routeへ即時反映されます。</p>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>閉じる</button>
      </div>

      <div className="form-grid">
        <label>
          <span>表示名</span>
          <input
            required
            value={form.name}
            onChange={(event) => onChange("name", event.target.value)}
            placeholder="Example App"
          />
        </label>
        <label>
          <span>アプリID</span>
          <input
            required
            value={form.id}
            disabled={editing}
            onChange={(event) => onChange("id", event.target.value)}
            placeholder="example-app"
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
          />
        </label>
        <label>
          <span>ホスト</span>
          <input
            required
            value={form.host}
            onChange={(event) => onChange("host", event.target.value)}
            placeholder="example.localhost"
          />
        </label>
        <label>
          <span>Upstream</span>
          <input
            required
            value={form.upstream}
            onChange={(event) => onChange("upstream", event.target.value)}
            placeholder="127.0.0.1:9000"
          />
        </label>
        <label className="form-span-2">
          <span>説明</span>
          <input
            value={form.description}
            onChange={(event) => onChange("description", event.target.value)}
            placeholder="このアプリの用途"
          />
        </label>
        <label className="form-span-2">
          <span>作業ディレクトリ</span>
          <input
            value={form.directory}
            onChange={(event) => onChange("directory", event.target.value)}
            placeholder="/absolute/path/to/app"
          />
        </label>
        <label>
          <span>操作方法</span>
          <select
            value={form.strategy}
            onChange={(event) => onChange("strategy", event.target.value)}
          >
            <option value="none">監視のみ</option>
            <option value="commands">管理コマンド</option>
            <option value="process">フォアグラウンドプロセス</option>
          </select>
        </label>
        <label>
          <span>必要な環境変数</span>
          <input
            value={form.requiredEnvironment}
            onChange={(event) => onChange("requiredEnvironment", event.target.value)}
            placeholder="API_KEY, OTHER_KEY"
          />
        </label>
        <label>
          <span>転送するHost（任意）</span>
          <input
            value={form.headerUpHost}
            onChange={(event) => onChange("headerUpHost", event.target.value)}
            placeholder="localhost"
          />
        </label>

        {form.strategy !== "none" && (
          <label className="form-span-2">
            <span>起動コマンド</span>
            <textarea
              required={form.strategy === "process"}
              value={form.startCommand}
              onChange={(event) => onChange("startCommand", event.target.value)}
              placeholder={"bin/server\n--port\n9000"}
              rows={4}
            />
            <small>実行ファイルと各引数を1行ずつ入力します。シェルは使用しません。</small>
          </label>
        )}

        {form.strategy === "commands" && (
          <>
            <label>
              <span>再起動コマンド</span>
              <textarea
                value={form.restartCommand}
                onChange={(event) => onChange("restartCommand", event.target.value)}
                placeholder={"bin/web\nrestart"}
                rows={4}
              />
            </label>
            <label>
              <span>停止コマンド</span>
              <textarea
                value={form.stopCommand}
                onChange={(event) => onChange("stopCommand", event.target.value)}
                placeholder={"bin/web\nstop"}
                rows={4}
              />
            </label>
            <label>
              <span>操作タイムアウト（ms）</span>
              <input
                type="number"
                min="100"
                max="3600000"
                value={form.timeoutMs}
                onChange={(event) => onChange("timeoutMs", event.target.value)}
              />
            </label>
          </>
        )}

        {form.strategy === "process" && (
          <>
            <label className="form-span-2">
              <span>ログ保存先</span>
              <input
                required
                value={form.logFile}
                onChange={(event) => onChange("logFile", event.target.value)}
                placeholder="/absolute/path/to/app/log/localdeck.log"
              />
            </label>
            <label>
              <span>起動待ち（ms）</span>
              <input
                type="number"
                min="100"
                max="3600000"
                value={form.startTimeoutMs}
                onChange={(event) => onChange("startTimeoutMs", event.target.value)}
              />
            </label>
            <label>
              <span>停止待ち（ms）</span>
              <input
                type="number"
                min="100"
                max="3600000"
                value={form.stopTimeoutMs}
                onChange={(event) => onChange("stopTimeoutMs", event.target.value)}
              />
            </label>
          </>
        )}
      </div>

      <div className="editor-actions">
        <button className="text-button" type="button" onClick={onCancel}>キャンセル</button>
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "保存中…" : editing ? "変更を保存" : "登録してrouteを作成"}
        </button>
      </div>
    </form>
  );
}

function AppCard({
  app,
  busy,
  copied,
  onAction,
  onCopy,
  onEdit,
  onDelete,
}: {
  app: LocalApp;
  busy: boolean;
  copied: string | null;
  onAction: (app: LocalApp, action: ActionName) => void;
  onCopy: (key: string, value: string) => void;
  onEdit: (app: LocalApp) => void;
  onDelete: (app: LocalApp) => void;
}) {
  const online = app.status === "online";
  const availableActions: ActionName[] = online ? ["restart", "stop"] : ["start"];

  return (
    <article className={`app-card app-card--${app.status}`}>
      <div className="app-card__rail" aria-hidden="true" />
      <div className="app-card__content">
        <div className="app-card__heading">
          <div className="app-identity">
            <span className={`status-orb status-orb--${app.status}`} aria-hidden="true" />
            <div>
              <div className="app-eyebrow">
                <span>{statusLabel(app.status)}</span>
                {app.latencyMs !== null && <span>{app.latencyMs} ms</span>}
              </div>
              <h2>{app.name}</h2>
            </div>
          </div>
          <div className="card-heading-actions">
            <button className="icon-button" type="button" onClick={() => onEdit(app)}>
              編集
            </button>
            <a className="open-app" href={app.url} target="_blank" rel="noreferrer">
              開く <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <p className="app-description">{app.description}</p>

        <div className="route-panel">
          <div className="route-main">
            <span className="field-label">CADDY URL</span>
            <a href={app.url} target="_blank" rel="noreferrer">
              {app.url}
            </a>
          </div>
          <button
            className="copy-button"
            type="button"
            onClick={() => onCopy(`${app.id}-url`, app.url)}
            aria-label={`${app.name} の URL をコピー`}
          >
            {copied === `${app.id}-url` ? "コピー済み" : "コピー"}
          </button>
        </div>

        <dl className="app-facts">
          <div>
            <dt>PORT</dt>
            <dd>{app.port ?? "—"}</dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd>{app.pid ?? "—"}</dd>
          </div>
          <div>
            <dt>UPTIME</dt>
            <dd>{app.uptime ?? "—"}</dd>
          </div>
          <div>
            <dt>UPSTREAM</dt>
            <dd>{app.upstream ?? "—"}</dd>
          </div>
        </dl>

        <div className="directory-row">
          <span className="field-label">DIRECTORY</span>
          <code title={app.directory ?? undefined}>{shortenPath(app.directory)}</code>
        </div>

        {!app.caddyRouteFound && (
          <div className="route-warning" role="note">
            <span aria-hidden="true">!</span>
            Caddy の現在設定にこのホストがありません。登録値で状態を監視しています。
          </div>
        )}

        <div className="app-actions">
          {availableActions.map((action) => {
            const availability = app.actions[action];
            return (
              <button
                key={action}
                className={`action-button action-button--${action}`}
                type="button"
                disabled={busy || !availability.enabled}
                onClick={() => onAction(app, action)}
                title={availability.reason ?? undefined}
              >
                <span aria-hidden="true">
                  {busy ? "…" : action === "start" ? "▶" : action === "restart" ? "↻" : "■"}
                </span>
                {busy ? "操作中" : actionLabel(action)}
              </button>
            );
          })}
          <button
            className="remove-button"
            type="button"
            disabled={busy}
            onClick={() => onDelete(app)}
          >
            登録削除
          </button>
        </div>
      </div>
    </article>
  );
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyApp, setBusyApp] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "warning" | "error";
    text: string;
  } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const loadSnapshot = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch("/api/apps", { cache: "no-store" });
      const body = await readJson<Snapshot>(response);
      setSnapshot(body);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "状態を取得できませんでした");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadSnapshot(true), 0);
    return () => window.clearTimeout(timeout);
  }, [loadSnapshot]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !busyApp) void loadSnapshot(true);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, busyApp, loadSnapshot]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const healthLabel = useMemo(() => {
    if (!snapshot) return "状態を取得中";
    if (snapshot.summary.offline === 0) return "すべて正常";
    return `${snapshot.summary.offline} 件を確認してください`;
  }, [snapshot]);

  async function handleAction(app: LocalApp, action: ActionName) {
    if (
      (action === "restart" || action === "stop") &&
      !window.confirm(`${app.name} を${actionLabel(action)}します。よろしいですか？`)
    ) {
      return;
    }

    setBusyApp(app.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/apps/${app.id}/${action}`, {
        method: "POST",
        headers: { "X-Localdeck-Action": "1" },
      });
      const body = await readJson<ActionResponse>(response);
      if (body.snapshot) setSnapshot(body.snapshot);
      setNotice({ tone: "success", text: body.message ?? `${app.name} を操作しました` });
    } catch (requestError) {
      setNotice({
        tone: "error",
        text: requestError instanceof Error ? requestError.message : "操作に失敗しました",
      });
      await loadSnapshot(true);
    } finally {
      setBusyApp(null);
    }
  }

  function openCreateEditor() {
    setForm(EMPTY_FORM);
    setEditorMode("create");
    window.setTimeout(() => document.querySelector(".app-editor")?.scrollIntoView({ behavior: "smooth" }), 0);
  }

  function openEditEditor(app: LocalApp) {
    setForm(definitionToForm(app.definition));
    setEditorMode("edit");
    window.setTimeout(() => document.querySelector(".app-editor")?.scrollIntoView({ behavior: "smooth" }), 0);
  }

  function updateForm(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSaveApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editing = editorMode === "edit";
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(editing ? `/api/apps/${form.id}` : "/api/apps", {
        method: editing ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Localdeck-Action": "1",
        },
        body: JSON.stringify(formToDefinition(form)),
      });
      const body = await readJson<ActionResponse>(response);
      if (body.snapshot) setSnapshot(body.snapshot);
      setNotice({
        tone: body.warning ? "warning" : "success",
        text: body.warning ? `${body.message}: ${body.warning}` : body.message ?? "保存しました",
      });
      setEditorMode(null);
    } catch (requestError) {
      setNotice({
        tone: "error",
        text: requestError instanceof Error ? requestError.message : "保存に失敗しました",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteApp(app: LocalApp) {
    const warning = app.status === "online"
      ? "アプリのプロセスは停止せず、登録とCaddy routeだけを削除します。"
      : "登録とCaddy routeを削除します。";
    if (!window.confirm(`${app.name}を削除します。${warning}`)) return;
    setBusyApp(app.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/apps/${app.id}`, {
        method: "DELETE",
        headers: { "X-Localdeck-Action": "1" },
      });
      const body = await readJson<ActionResponse>(response);
      if (body.snapshot) setSnapshot(body.snapshot);
      setNotice({
        tone: body.warning ? "warning" : "success",
        text: body.warning ? `${body.message}: ${body.warning}` : body.message ?? "削除しました",
      });
      if (form.id === app.id) setEditorMode(null);
    } catch (requestError) {
      setNotice({
        tone: "error",
        text: requestError instanceof Error ? requestError.message : "削除に失敗しました",
      });
    } finally {
      setBusyApp(null);
    }
  }

  async function handleCaddySync() {
    setRefreshing(true);
    setNotice(null);
    try {
      const response = await fetch("/api/caddy/sync", {
        method: "POST",
        headers: { "X-Localdeck-Action": "1" },
      });
      const body = await readJson<ActionResponse>(response);
      if (body.snapshot) setSnapshot(body.snapshot);
      setNotice({ tone: "success", text: body.message ?? "Caddyへ同期しました" });
    } catch (requestError) {
      setNotice({
        tone: "error",
        text: requestError instanceof Error ? requestError.message : "Caddy同期に失敗しました",
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCopy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1_800);
    } catch {
      setNotice({ tone: "error", text: "クリップボードへコピーできませんでした" });
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Localdeck トップ">
          <span className="brand-mark" aria-hidden="true">
            L/
          </span>
          <span>
            <strong>LOCALDECK</strong>
            <small>LOCAL APP CONTROL</small>
          </span>
        </a>
        <div className="topbar-actions">
          <button className="primary-button primary-button--compact" type="button" onClick={openCreateEditor}>
            ＋ アプリ登録
          </button>
          <label className="auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span aria-hidden="true" />
            自動更新
          </label>
          <button
            className={`refresh-button${refreshing ? " is-refreshing" : ""}`}
            type="button"
            onClick={() => void loadSnapshot(false)}
            disabled={refreshing}
          >
            <span aria-hidden="true">↻</span>
            更新
          </button>
        </div>
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <span className="section-kicker">LOCAL / OPERATIONS</span>
          <h1>ローカルアプリ管制室</h1>
          <p>アプリの登録からCaddy route、起動・再起動・停止まで、ここで一括管理できます。</p>
        </div>
        <div className="system-readout" aria-label="システム概要">
          <div className="readout-status">
            <span
              className={`status-orb status-orb--${snapshot?.summary.offline === 0 ? "online" : "offline"}`}
              aria-hidden="true"
            />
            <div>
              <span>SYSTEM STATUS</span>
              <strong>{loading ? "接続中" : healthLabel}</strong>
            </div>
          </div>
          <div className="readout-numbers">
            <div>
              <strong>{snapshot?.summary.online ?? "—"}</strong>
              <span>ONLINE</span>
            </div>
            <div>
              <strong>{snapshot?.summary.offline ?? "—"}</strong>
              <span>OFFLINE</span>
            </div>
            <div>
              <strong>{snapshot?.summary.total ?? "—"}</strong>
              <span>TOTAL</span>
            </div>
          </div>
        </div>
      </section>

      <section className="connection-strip" aria-label="接続状態">
        <div>
          <span
            className={`mini-light ${snapshot?.caddy.connected ? "mini-light--online" : "mini-light--offline"}`}
            aria-hidden="true"
          />
          <strong>Caddy</strong>
          <span>{snapshot?.caddy.connected ? "接続済み" : loading ? "確認中" : "未接続"}</span>
          {snapshot?.caddy.connected && (
            <span>{snapshot.caddy.routeCount}/{snapshot.caddy.expectedRouteCount} app routes</span>
          )}
          {snapshot?.caddy.connected && !snapshot.caddy.inSync && (
            <button className="inline-sync" type="button" onClick={() => void handleCaddySync()}>
              再同期
            </button>
          )}
        </div>
        <div>
          <span>最終確認</span>
          <time dateTime={snapshot?.generatedAt}>{formatCheckedAt(snapshot?.generatedAt)}</time>
          <span className="refresh-cadence">{autoRefresh ? "5秒ごと" : "手動更新"}</span>
        </div>
      </section>

      {error && (
        <section className="error-banner" role="alert">
          <div>
            <strong>管理 API に接続できません</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => void loadSnapshot(false)}>
            再試行
          </button>
        </section>
      )}

      <section className="apps-section" aria-labelledby="apps-heading">
        <div className="section-heading">
          <div>
            <span className="section-kicker">SERVICES</span>
            <h2 id="apps-heading">アプリ一覧</h2>
          </div>
          <div className="section-heading-actions">
            <span>{snapshot ? `${snapshot.apps.length} APPS` : "READING…"}</span>
            <button className="primary-button primary-button--compact" type="button" onClick={openCreateEditor}>
              ＋ 登録
            </button>
          </div>
        </div>

        {editorMode && (
          <AppEditor
            form={form}
            editing={editorMode === "edit"}
            saving={saving}
            onChange={updateForm}
            onCancel={() => setEditorMode(null)}
            onSubmit={(event) => void handleSaveApp(event)}
          />
        )}

        <div className="apps-grid" aria-busy={loading}>
          {snapshot?.apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              busy={busyApp === app.id}
              copied={copied}
              onAction={(selectedApp, action) => void handleAction(selectedApp, action)}
              onCopy={(key, value) => void handleCopy(key, value)}
              onEdit={openEditEditor}
              onDelete={(selectedApp) => void handleDeleteApp(selectedApp)}
            />
          ))}

          {loading && !snapshot && (
            <div className="loading-panel" role="status">
              <span className="loading-pulse" aria-hidden="true" />
              <div>
                <strong>SQLiteとCaddyの状態を確認しています</strong>
                <span>ポートとプロセス情報を読み込み中…</span>
              </div>
            </div>
          )}

          {!loading && snapshot?.apps.length === 0 && (
            <div className="loading-panel">
              <div>
                <strong>登録済みアプリはありません</strong>
                <span>「アプリ登録」から最初のrouteを追加できます。</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <footer>
        <span>LOCALDECK / LOOPBACK ONLY</span>
        <span>コマンドはシェルを介さず、登録した引数だけを実行します。</span>
      </footer>

      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {notice && <div className={`toast toast--${notice.tone}`}>{notice.text}</div>}
      </div>
    </main>
  );
}
