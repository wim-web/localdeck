import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

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

type Notice = {
  tone: "warning" | "error";
  text: string;
};

type PendingDelete = {
  app: LocalApp;
  timeoutId: number;
};

type CommandItem = {
  id: string;
  label: string;
  keywords: string;
  disabled?: boolean;
  reason?: string | null;
  tone?: "default" | "danger";
  run: () => void;
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
    <form className="app-editor editor-panel" onSubmit={onSubmit}>
      <div className="editor-heading">
        <div>
          <span className="editor-mode">{editing ? "設定を編集" : "新規登録"}</span>
          <h3>{editing ? `${form.name}の設定` : "アプリを登録"}</h3>
          <p>保存するとSQLiteとCaddy routeへ即時反映されます。</p>
        </div>
        <button className="button button--quiet" type="button" onClick={onCancel}>閉じる</button>
      </div>

      <div className="form-grid">
        <label>
          <span>表示名</span>
          <input
            required
            value={form.name}
            onChange={(event) => onChange("name", event.target.value)}
            placeholder="Docs server"
          />
        </label>
        <label>
          <span>アプリID</span>
          <input
            required
            value={form.id}
            disabled={editing}
            onChange={(event) => onChange("id", event.target.value)}
            placeholder="docs-server"
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
          />
        </label>
        <label>
          <span>ホスト</span>
          <input
            required
            value={form.host}
            onChange={(event) => onChange("host", event.target.value)}
            placeholder="docs.localhost"
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
            placeholder="ドキュメントのプレビュー"
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
        <button className="button button--quiet" type="button" onClick={onCancel}>キャンセル</button>
        <button
          className="button button--solid"
          type="submit"
          disabled={saving}
          aria-busy={saving}
          data-state={saving ? "loading" : "default"}
        >
          {saving ? "保存中…" : editing ? "変更を保存" : "アプリを登録"}
        </button>
      </div>
    </form>
  );
}

function AppRow({
  app,
  busy,
  copied,
  deletePending,
  onAction,
  onCopy,
  onEdit,
  onDelete,
}: {
  app: LocalApp;
  busy: boolean;
  copied: string | null;
  deletePending: boolean;
  onAction: (app: LocalApp, action: ActionName) => void;
  onCopy: (key: string, value: string) => void;
  onEdit: (app: LocalApp) => void;
  onDelete: (app: LocalApp) => void;
}) {
  const online = app.status === "online";
  const availableActions: ActionName[] = online ? ["restart", "stop"] : ["start"];
  const copyKey = app.id + "-url";
  const unavailable = availableActions.filter((action) => !app.actions[action].enabled);

  return (
    <article className={"app-row app-row--" + app.status}>
      <div className="app-row__identity">
        <div className="status-line">
          <span className={"status-dot status-dot--" + app.status} aria-hidden="true" />
          <span>{statusLabel(app.status)}</span>
          {app.latencyMs !== null && <span className="status-latency">{app.latencyMs} ms</span>}
        </div>
        <h3>{app.name}</h3>
        <p>{app.description || "説明なし"}</p>
      </div>

      <div className="app-row__route">
        <span className="cell-label">Route</span>
        <div className="route-value">
          <a href={app.url} target="_blank" rel="noreferrer">
            {app.host}
          </a>
          <button
            className="button button--copy"
            type="button"
            onClick={() => onCopy(copyKey, app.url)}
            aria-label={app.name + " のURLをコピー"}
            data-state={copied === copyKey ? "success" : "default"}
          >
            {copied === copyKey ? "コピー済み" : "コピー"}
          </button>
        </div>
        <code>{app.upstream ?? "upstream未取得"}</code>
      </div>

      <dl className="app-row__runtime">
        <div>
          <dt>Port</dt>
          <dd>{app.port ?? "—"}</dd>
        </div>
        <div>
          <dt>PID</dt>
          <dd>{app.pid ?? "—"}</dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{app.uptime ?? "—"}</dd>
        </div>
      </dl>

      <div className="app-row__actions">
        <div className="action-group" aria-label={app.name + " のプロセス操作"}>
          {availableActions.map((action) => {
            const availability = app.actions[action];
            const reasonId = app.id + "-" + action + "-reason";
            return (
              <button
                key={action}
                className={"button button--process button--" + action}
                type="button"
                disabled={busy || !availability.enabled}
                onClick={() => onAction(app, action)}
                aria-busy={busy}
                aria-describedby={!availability.enabled && availability.reason ? reasonId : undefined}
                data-state={busy ? "loading" : availability.enabled ? "default" : "disabled"}
              >
                <span aria-hidden="true">
                  {busy ? "…" : action === "start" ? "▶" : action === "restart" ? "↻" : "■"}
                </span>
                {busy ? "操作中" : actionLabel(action)}
              </button>
            );
          })}
        </div>
        <div className="row-tools">
          <button className="button button--quiet" type="button" onClick={() => onEdit(app)}>
            編集
          </button>
          <a className="button button--quiet" href={app.url} target="_blank" rel="noreferrer">
            開く <span aria-hidden="true">↗</span>
          </a>
          <button
            className="button button--danger"
            type="button"
            disabled={busy || deletePending}
            onClick={() => onDelete(app)}
          >
            登録削除
          </button>
        </div>
        {unavailable.length > 0 && (
          <div className="action-reasons">
            {unavailable.map((action) => (
              <p key={action} id={app.id + "-" + action + "-reason"}>
                {actionLabel(action)}できません — {app.actions[action].reason}
              </p>
            ))}
          </div>
        )}
      </div>

      <details className="app-row__details">
        <summary>詳細</summary>
        <dl>
          <div>
            <dt>Directory</dt>
            <dd><code>{shortenPath(app.directory)}</code></dd>
          </div>
          <div>
            <dt>Direct URL</dt>
            <dd>{app.directUrl ?? "—"}</dd>
          </div>
          <div>
            <dt>Caddy route</dt>
            <dd>{app.caddyRouteFound ? "同期済み" : "未同期"}</dd>
          </div>
          <div>
            <dt>設定</dt>
            <dd>{app.configured ? "登録済み" : "検出のみ"}</dd>
          </div>
        </dl>
      </details>

      {!app.caddyRouteFound && (
        <div className="route-warning" role="note">
          <span aria-hidden="true">!</span>
          Caddyの現在設定にこのホストがありません。登録値で状態を監視しています。
        </div>
      )}
    </article>
  );
}

function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ja-JP");
    if (!normalized) return commands;
    return commands.filter((command) =>
      (command.label + " " + command.keywords).toLocaleLowerCase("ja-JP").includes(normalized),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.getElementById("app-workbench")?.setAttribute("inert", "");
    const frame = window.requestAnimationFrame(() => {
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.getElementById("app-workbench")?.removeAttribute("inert");
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  function moveSelection(direction: 1 | -1) {
    if (filteredCommands.length === 0) return;
    let next = activeIndex;
    for (let attempts = 0; attempts < filteredCommands.length; attempts += 1) {
      next = (next + direction + filteredCommands.length) % filteredCommands.length;
      if (!filteredCommands[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function runCommand(command: CommandItem) {
    if (command.disabled) return;
    command.run();
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filteredCommands[activeIndex];
      if (command) runCommand(command);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="command-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-title"
      >
        <header>
          <div>
            <h2 id="command-title">コマンド</h2>
            <p>登録、更新、アプリ操作を名前で絞り込みます。</p>
          </div>
          <button className="button button--palette-close" type="button" onClick={onClose}>
            閉じる
          </button>
        </header>
        <label className="command-search">
          <span>操作を検索</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="アプリ名または操作"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={
              filteredCommands[activeIndex] ? "command-" + filteredCommands[activeIndex].id : undefined
            }
          />
        </label>
        <p className="command-count" aria-live="polite">
          {filteredCommands.length}件
        </p>
        <div className="command-results" id="command-results" role="listbox">
          {filteredCommands.map((command, index) => (
            <button
              id={"command-" + command.id}
              key={command.id}
              className={
                "command-item" +
                (index === activeIndex ? " is-active" : "") +
                (command.tone === "danger" ? " command-item--danger" : "")
              }
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              disabled={command.disabled}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => runCommand(command)}
            >
              <span>{command.label}</span>
              {command.disabled && command.reason && <small>{command.reason}</small>}
            </button>
          ))}
          {filteredCommands.length === 0 && (
            <p className="command-empty">一致する操作はありません。</p>
          )}
        </div>
        <footer>
          <span>↑↓ 選択</span>
          <span>Enter 実行</span>
          <span>Esc 閉じる</span>
        </footer>
      </section>
    </div>
  );
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyApp, setBusyApp] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

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
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((current) => !current);
      } else if (event.key === "Escape") {
        setCommandOpen(false);
      }
    }
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!pendingDelete) return;
    return () => window.clearTimeout(pendingDelete.timeoutId);
  }, [pendingDelete]);

  const healthLabel = useMemo(() => {
    if (!snapshot) return "状態を取得中";
    if (snapshot.summary.offline === 0) return "すべて正常";
    return `${snapshot.summary.offline} 件を確認してください`;
  }, [snapshot]);

  async function handleAction(app: LocalApp, action: ActionName) {
    setBusyApp(app.id);
    setNotice(null);
    try {
      const response = await fetch("/api/apps/" + app.id + "/" + action, {
        method: "POST",
        headers: { "X-Localdeck-Action": "1" },
      });
      const body = await readJson<ActionResponse>(response);
      if (body.snapshot) setSnapshot(body.snapshot);
      if (body.warning) {
        setNotice({ tone: "warning", text: (body.message ?? app.name) + ": " + body.warning });
      }
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
    scrollEditorIntoView();
  }

  function openEditEditor(app: LocalApp) {
    setForm(definitionToForm(app.definition));
    setEditorMode("edit");
    scrollEditorIntoView();
  }

  function scrollEditorIntoView() {
    window.setTimeout(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.querySelector(".app-editor")?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    }, 0);
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
      const response = await fetch(editing ? "/api/apps/" + form.id : "/api/apps", {
        method: editing ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Localdeck-Action": "1",
        },
        body: JSON.stringify(formToDefinition(form)),
      });
      const body = await readJson<ActionResponse>(response);
      if (body.snapshot) setSnapshot(body.snapshot);
      if (body.warning) {
        setNotice({
          tone: "warning",
          text: (body.message ?? "保存しました") + ": " + body.warning,
        });
      }
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

  function handleDeleteApp(app: LocalApp) {
    if (pendingDelete || busyApp) return;
    const timeoutId = window.setTimeout(() => void commitDeleteApp(app), 8_000);
    setPendingDelete({ app, timeoutId });
    setNotice(null);
    if (form.id === app.id) setEditorMode(null);
  }

  function undoDelete() {
    if (!pendingDelete) return;
    window.clearTimeout(pendingDelete.timeoutId);
    setPendingDelete(null);
  }

  async function commitDeleteApp(app: LocalApp) {
    setPendingDelete((current) => current?.app.id === app.id ? null : current);
    setBusyApp(app.id);
    setNotice(null);
    try {
      const response = await fetch("/api/apps/" + app.id, {
        method: "DELETE",
        headers: { "X-Localdeck-Action": "1" },
      });
      const body = await readJson<ActionResponse>(response);
      if (body.snapshot) setSnapshot(body.snapshot);
      if (body.warning) {
        setNotice({
          tone: "warning",
          text: (body.message ?? "登録を削除しました") + ": " + body.warning,
        });
      }
    } catch (requestError) {
      setNotice({
        tone: "error",
        text: requestError instanceof Error ? requestError.message : "削除に失敗しました",
      });
      await loadSnapshot(true);
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
      if (body.warning) {
        setNotice({
          tone: "warning",
          text: (body.message ?? "Caddyへ同期しました") + ": " + body.warning,
        });
      }
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

  const visibleApps = snapshot?.apps.filter((app) => app.id !== pendingDelete?.app.id) ?? [];
  const commands: CommandItem[] = [
    {
      id: "register",
      label: "アプリを登録",
      keywords: "new create registration 新規",
      run: openCreateEditor,
    },
    {
      id: "refresh",
      label: "状態を更新",
      keywords: "refresh reload 再読込",
      disabled: refreshing,
      reason: refreshing ? "更新中" : null,
      run: () => void loadSnapshot(false),
    },
    {
      id: "auto-refresh",
      label: autoRefresh ? "自動更新を停止" : "自動更新を開始",
      keywords: "auto refresh polling 5秒",
      run: () => setAutoRefresh((current) => !current),
    },
    {
      id: "caddy-sync",
      label: "Caddy routeを同期",
      keywords: "caddy route sync 再同期",
      disabled: refreshing || !snapshot?.caddy.connected || snapshot.caddy.inSync,
      reason: !snapshot?.caddy.connected
        ? "Caddy未接続"
        : snapshot.caddy.inSync
          ? "同期済み"
          : refreshing
            ? "更新中"
            : null,
      run: () => void handleCaddySync(),
    },
  ];

  snapshot?.apps.forEach((app) => {
    commands.push(
      {
        id: app.id + "-open",
        label: app.name + "を開く",
        keywords: app.host + " open browser",
        run: () => {
          const opened = window.open(app.url, "_blank", "noopener,noreferrer");
          if (opened) opened.opener = null;
        },
      },
      {
        id: app.id + "-copy",
        label: app.name + "のURLをコピー",
        keywords: app.host + " copy clipboard",
        run: () => void handleCopy(app.id + "-url", app.url),
      },
      {
        id: app.id + "-edit",
        label: app.name + "の設定を編集",
        keywords: app.host + " edit configure",
        run: () => openEditEditor(app),
      },
    );

    const actions: ActionName[] = app.status === "online" ? ["restart", "stop"] : ["start"];
    actions.forEach((action) => {
      const availability = app.actions[action];
      commands.push({
        id: app.id + "-" + action,
        label: app.name + "を" + actionLabel(action),
        keywords: app.host + " process " + action,
        disabled: busyApp === app.id || !availability.enabled,
        reason: busyApp === app.id ? "操作中" : availability.reason,
        run: () => void handleAction(app, action),
      });
    });

    commands.push({
      id: app.id + "-delete",
      label: app.name + "の登録を削除",
      keywords: app.host + " remove delete",
      disabled: Boolean(pendingDelete) || busyApp === app.id,
      reason: pendingDelete ? "別の削除を取り消せます" : busyApp === app.id ? "操作中" : null,
      tone: "danger",
      run: () => handleDeleteApp(app),
    });
  });

  return (
    <>
      <main className="workbench" id="app-workbench">
        <header className="topbar" id="top">
          <a className="brand" href="#top" aria-label="Localdeck トップ">
            <span className="brand-signal" aria-hidden="true">L/</span>
            <span className="brand-copy">
              <strong>LOCALDECK</strong>
              <small>LOCAL APP CONTROL</small>
            </span>
          </a>

          <div className="topbar-actions">
            <button
              className="button command-trigger"
              type="button"
              onClick={() => setCommandOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={commandOpen}
            >
              <span>コマンド</span>
              <kbd>⌘K</kbd>
            </button>
            <label className="auto-refresh">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-label">自動更新</span>
            </label>
            <button
              className="button refresh-button"
              type="button"
              onClick={() => void loadSnapshot(false)}
              disabled={refreshing}
              aria-busy={refreshing}
              data-state={refreshing ? "loading" : "default"}
            >
              <span className="refresh-glyph" aria-hidden="true">↻</span>
              {refreshing ? "更新中" : "更新"}
            </button>
          </div>
        </header>

        <section className="workbench-overview" aria-labelledby="page-heading">
          <div className="overview-copy">
            <h1 id="page-heading">ローカルアプリ</h1>
            <p>登録、Caddy route、プロセス状態を一画面で確認し、その場で操作します。</p>
          </div>
          <div className="health-block">
            <div className="health-state">
              <span
                className={
                  "status-dot status-dot--" +
                  (snapshot?.summary.offline === 0 ? "online" : "offline")
                }
                aria-hidden="true"
              />
              <div>
                <span>システム状態</span>
                <strong>{loading ? "確認中" : healthLabel}</strong>
              </div>
            </div>
            <div className="checked-at">
              <span>最終確認</span>
              <time dateTime={snapshot?.generatedAt}>{formatCheckedAt(snapshot?.generatedAt)}</time>
            </div>
          </div>
        </section>

        <section className="stat-strip" aria-label="システム概要">
          <div>
            <strong>{snapshot?.summary.online ?? "—"}</strong>
            <span>稼働中</span>
          </div>
          <div>
            <strong>{snapshot?.summary.offline ?? "—"}</strong>
            <span>停止中</span>
          </div>
          <div>
            <strong>{snapshot?.summary.total ?? "—"}</strong>
            <span>登録数</span>
          </div>
          <div>
            <strong>
              {snapshot ? snapshot.caddy.routeCount + "/" + snapshot.caddy.expectedRouteCount : "—"}
            </strong>
            <span>Caddy routes</span>
          </div>
        </section>

        <section className="connection-bar" aria-label="Caddy接続状態">
          <div className="connection-state">
            <span
              className={
                "status-dot status-dot--" +
                (snapshot?.caddy.connected ? "online" : loading ? "unknown" : "offline")
              }
              aria-hidden="true"
            />
            <strong>Caddy</strong>
            <span>{snapshot?.caddy.connected ? "接続済み" : loading ? "確認中" : "未接続"}</span>
            {snapshot?.caddy.latencyMs !== null && snapshot?.caddy.latencyMs !== undefined && (
              <span className="connection-latency">{snapshot.caddy.latencyMs} ms</span>
            )}
          </div>
          <div className="connection-actions">
            {snapshot?.caddy.connected && !snapshot.caddy.inSync && (
              <button
                className="button button--sync"
                type="button"
                onClick={() => void handleCaddySync()}
                disabled={refreshing}
              >
                Routeを同期
              </button>
            )}
            <span>{autoRefresh ? "5秒ごとに更新" : "手動更新"}</span>
          </div>
        </section>

        {error && (
          <section className="error-banner" role="alert">
            <div>
              <strong>管理APIに接続できません</strong>
              <span>{error}。サーバーの状態を確認して再試行してください。</span>
            </div>
            <button className="button button--error" type="button" onClick={() => void loadSnapshot(false)}>
              再試行
            </button>
          </section>
        )}

        <section className="registry" aria-labelledby="apps-heading">
          <header className="registry-heading">
            <div>
              <h2 id="apps-heading">アプリ一覧</h2>
              <p>{snapshot ? snapshot.apps.length + "件を登録中" : "状態を読み込み中"}</p>
            </div>
            <button className="button button--register" type="button" onClick={openCreateEditor}>
              アプリを登録
            </button>
          </header>

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

          <div className="apps-ledger" aria-busy={loading}>
            <div className="ledger-head" aria-hidden="true">
              <span>Application</span>
              <span>Route</span>
              <span>Runtime</span>
              <span>Operations</span>
            </div>

            {visibleApps.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                busy={busyApp === app.id}
                copied={copied}
                deletePending={Boolean(pendingDelete)}
                onAction={(selectedApp, action) => void handleAction(selectedApp, action)}
                onCopy={(key, value) => void handleCopy(key, value)}
                onEdit={openEditEditor}
                onDelete={handleDeleteApp}
              />
            ))}

            {loading && !snapshot && (
              <div className="loading-panel" role="status">
                <span className="loading-indicator" aria-hidden="true" />
                <div>
                  <strong>SQLiteとCaddyを確認中</strong>
                  <span>アプリとプロセスの状態を読み込んでいます。</span>
                </div>
              </div>
            )}

            {!loading && snapshot?.apps.length === 0 && (
              <div className="empty-state">
                <span className="empty-mark" aria-hidden="true">0</span>
                <div>
                  <strong>登録済みアプリはありません</strong>
                  <span>最初のhost、upstream、起動方法を登録してください。</span>
                </div>
                <button className="button button--register" type="button" onClick={openCreateEditor}>
                  アプリを登録
                </button>
              </div>
            )}
          </div>
        </section>

        <footer className="footer-line">
          <span>LOCALDECK · LOOPBACK ONLY</span>
          <span>コマンドはシェルを介さず、登録した引数だけを実行します。</span>
        </footer>

        <div className="feedback-stack">
          {pendingDelete && (
            <div className="undo-notice" role="status">
              <div>
                <strong>{pendingDelete.app.name}を一覧から外しました</strong>
                <span>
                  {pendingDelete.app.status === "online"
                    ? "8秒後に登録とrouteを削除します。プロセスは停止しません。"
                    : "8秒後に登録とrouteを削除します。"}
                </span>
              </div>
              <button className="button button--undo" type="button" onClick={undoDelete}>
                元に戻す
              </button>
            </div>
          )}
          {notice && (
            <div className={"notice notice--" + notice.tone} role="alert">
              <span>{notice.text}</span>
              <button className="button button--notice-close" type="button" onClick={() => setNotice(null)}>
                閉じる
              </button>
            </div>
          )}
        </div>
      </main>

      <CommandPalette
        open={commandOpen}
        commands={commands}
        onClose={() => setCommandOpen(false)}
      />
    </>
  );
}
