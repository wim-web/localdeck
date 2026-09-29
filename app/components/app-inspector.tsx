import { useEffect, useRef, useState } from "react";
import {
  fetchLogs,
  fetchProcessDetails,
  type ProcessDetails,
} from "../localdeck-api";
import { formatCheckedAt } from "../formatters";
import { commandToText } from "../app-form";
import type { LocalApp } from "../localdeck-types";
import { Icon } from "./icon";
import { Modal } from "./modal";

export function AppInspector({
  app,
  initialTab,
  onClose,
}: {
  app: LocalApp;
  initialTab: "details" | "logs";
  onClose(): void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [source, setSource] = useState("main");
  const [logs, setLogs] = useState({ text: "", bytes: 0, truncated: false });
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const [details, setDetails] = useState<ProcessDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsRefresh, setDetailsRefresh] = useState(0);
  useEffect(() => {
    if (tab !== "details") return;
    const controller = new AbortController();
    void fetchProcessDetails(app.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setDetails(result);
          setDetailsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setDetailsError(
            error instanceof Error
              ? error.message
              : "プロセス情報を取得できませんでした",
          );
      });
    return () => controller.abort();
  }, [app.id, tab, detailsRefresh]);
  useEffect(() => {
    if (tab !== "logs") return;
    const controller = new AbortController();
    let active = false;
    const load = async () => {
      if (active || controller.signal.aborted) return;
      active = true;
      try {
        const result = await fetchLogs(app.id, source, controller.signal);
        if (!controller.signal.aborted) {
          setLogs(result);
          setError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "ログを読み込めませんでした",
          );
      } finally {
        active = false;
      }
    };
    void load();
    const timer = follow
      ? window.setInterval(() => void load(), 1000)
      : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [app.id, source, tab, follow, refresh]);
  useEffect(() => {
    if (follow && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.text, follow]);
  return (
    <Modal title={app.name} subtitle={app.host} onClose={onClose} wide>
      <nav className="editor-tabs" aria-label="アプリ情報">
        <button
          className={tab === "details" ? "active" : ""}
          onClick={() => setTab("details")}
        >
          詳細
        </button>
        <button
          className={tab === "logs" ? "active" : ""}
          onClick={() => setTab("logs")}
        >
          ログ
        </button>
      </nav>
      {tab === "details" ? (
        <div className="modal-body">
          {app.runtime?.lastError && (
            <div className="inline-error">
              <Icon name="alert" />
              <p>{app.runtime.lastError}</p>
            </div>
          )}
          <div className="process-list">
            <div className="process-heading">
              <h3>プロセス</h3>
              <button
                className="button quiet"
                type="button"
                onClick={() => setDetailsRefresh((value) => value + 1)}
              >
                <Icon name="refresh" size={14} />
                情報を再取得
              </button>
            </div>
            <p className="process-checked">
              {details
                ? `${formatCheckedAt(details.checkedAt)} に取得`
                : detailsError
                  ? "情報を取得できませんでした"
                  : "情報を取得中…"}
            </p>
            {detailsError && (
              <p className="inline-error" role="alert">
                {detailsError}
              </p>
            )}
            {(
              details?.processes ??
              app.runtime?.processes ?? [
                {
                  id: "main",
                  name: "メイン",
                  online: app.status === "online",
                  port: app.port,
                  pid: app.pid,
                },
              ]
            ).map((process) => (
              <div className="process-line" key={process.id}>
                <span
                  className={`status-dot ${process.online ? "online" : "offline"}`}
                />
                <strong>{process.name}</strong>
                <code>:{process.port}</code>
                <small>PID {process.pid ?? "—"}</small>
                <button
                  className="button quiet"
                  onClick={() => {
                    setSource(process.id);
                    setTab("logs");
                  }}
                >
                  <Icon name="log" size={15} />
                  ログ
                </button>
              </div>
            ))}
          </div>
          <dl className="detail-list">
            <div>
              <dt>URL</dt>
              <dd>
                <a href={app.url} target="_blank" rel="noreferrer">
                  {app.url}
                  <Icon name="external" size={13} />
                </a>
              </dd>
            </div>
            <div>
              <dt>フォルダ</dt>
              <dd>
                <code>{app.directory ?? "未設定"}</code>
              </dd>
            </div>
            <div>
              <dt>起動コマンド</dt>
              <dd>
                <code>
                  {commandToText(app.definition.lifecycle?.start) || "監視のみ"}
                </code>
              </dd>
            </div>
            <div>
              <dt>転送先</dt>
              <dd>
                <code>{app.upstream}</code>
              </dd>
            </div>
            <div>
              <dt>稼働時間</dt>
              <dd>{details?.uptime ?? "—"}</dd>
            </div>
            <div>
              <dt>アクセス時に起動</dt>
              <dd>{app.definition.options?.wakeOnRequest ? "有効" : "無効"}</dd>
            </div>
            <div>
              <dt>自動停止</dt>
              <dd>
                {app.definition.options?.idleStopMinutes
                  ? `${app.definition.options.idleStopMinutes}分アクセスがなければ停止`
                  : "無効"}
              </dd>
            </div>
            <div>
              <dt>ルート</dt>
              <dd>{app.caddyRouteFound ? "登録済み" : "未反映"}</dd>
            </div>
          </dl>
          {app.runtime?.idleReason && (
            <p className="muted-panel">{app.runtime.idleReason}</p>
          )}
        </div>
      ) : (
        <>
          <div className="log-toolbar">
            <select
              aria-label="ログのプロセス"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setLogs({ text: "", bytes: 0, truncated: false });
              }}
            >
              <option value="main">メイン</option>
              {app.definition.options?.backends.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <label className="check-row">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              追従
            </label>
            <button
              className="icon-button"
              onClick={() => setRefresh((n) => n + 1)}
              aria-label="ログを更新"
            >
              <Icon name="refresh" />
            </button>
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(logs.text);
                  setCopied(true);
                } catch {
                  setError("コピーできませんでした");
                }
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={15} />
              {copied ? "コピー済み" : "コピー"}
            </button>
          </div>
          {error && (
            <p className="log-error" role="alert">
              {error}
            </p>
          )}
          <textarea
            className="log-output"
            ref={logRef}
            readOnly
            aria-label="プロセスログ"
            value={logs.text || "ログはまだありません。"}
          />
          <footer className="log-footer">
            <span>
              {logs.truncated ? "末尾128KBを表示" : "保存済みログを表示"}
            </span>
            <span>
              {Math.ceil(logs.bytes / 1024)} KB ·{" "}
              {follow ? "1秒ごとに更新" : "追従を一時停止"}
            </span>
          </footer>
        </>
      )}
    </Modal>
  );
}
