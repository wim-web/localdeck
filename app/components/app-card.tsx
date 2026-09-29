import { useState } from "react";
import type { DragEvent } from "react";
import type { ActionName, Category, LocalApp } from "../localdeck-types";
import { Icon } from "./icon";

export function appPhase(app: LocalApp) {
  return (
    app.runtime?.phase ?? (app.status === "online" ? "running" : "stopped")
  );
}
export function AppCard({
  app,
  busy,
  category,
  checkedAt,
  onAction,
  onEdit,
  onInspect,
  onDelete,
  onKeepAlive,
  onMove,
  onDragStart,
  onDrop,
  first,
  last,
}: {
  app: LocalApp;
  busy: boolean;
  category?: Category;
  checkedAt: string;
  onAction(app: LocalApp, action: ActionName): void;
  onEdit(app: LocalApp): void;
  onInspect(app: LocalApp, tab: "details" | "logs"): void;
  onDelete(app: LocalApp): void;
  onKeepAlive(app: LocalApp): void;
  onMove(app: LocalApp, offset: number): void;
  onDragStart(event: DragEvent, app: LocalApp): void;
  onDrop(event: DragEvent, app: LocalApp): void;
  first: boolean;
  last: boolean;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const phase = appPhase(app);
  const waiting = phase === "stopped" && app.definition.options?.wakeOnRequest;
  const status = waiting ? "waiting" : phase;
  const statusText = {
    running: "稼働中",
    starting: "起動中",
    stopping: "停止中…",
    stopped: "停止中",
    error: "エラー",
    waiting: "待ち受け",
  }[status];
  const isBusy = busy || phase === "starting" || phase === "stopping";
  const idleRemaining = app.runtime?.idleUntil
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(app.runtime.idleUntil) - Date.parse(checkedAt)) / 60_000,
        ),
      )
    : null;
  return (
    <article
      className={`app-card ${isBusy ? "is-busy" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, app)}
    >
      <button
        className="drag-handle"
        draggable
        onDragStart={(event) => onDragStart(event, app)}
        type="button"
        aria-label={`${app.name}をドラッグで並べ替え`}
        title="ドラッグで並べ替え"
      >
        <Icon name="grip" size={16} />
      </button>
      <div
        className={`app-avatar color-${category?.color ?? ["purple", "orange", "blue"][app.id.length % 3]}`}
      >
        {iconFailed ? (
          <span>{app.name.slice(0, 1).toUpperCase()}</span>
        ) : (
          <img
            src={`/api/apps/${app.id}/favicon`}
            alt=""
            onError={() => setIconFailed(true)}
          />
        )}
        <i className={`avatar-status ${status}`} />
      </div>
      <div className="app-card-main">
        <div className="app-title-line">
          <h3>{app.name}</h3>
          <span className={`status-badge ${status}`}>
            {isBusy && <span className="spinner" />}
            {statusText}
          </span>
          {category && (
            <span className={`category-tag color-${category.color}`}>
              {category.name}
            </span>
          )}
        </div>
        <p className="app-description">{app.description || "ローカルアプリ"}</p>
        <a className="app-url" href={app.url} target="_blank" rel="noreferrer">
          {app.host}
          <Icon name="external" size={13} />
        </a>
        <div className="app-meta">
          <span>
            <Icon name="server" size={13} />
            {app.port ?? "—"}
            {app.definition.options?.port.mode === "auto" ? " · 自動" : ""}
          </span>
          {(app.runtime?.processes.length ?? 1) > 1 && (
            <span>
              {app.runtime?.processes.filter((p) => p.online).length}/
              {app.runtime?.processes.length} プロセス
            </span>
          )}
          {app.definition.options?.idleStopMinutes ? (
            <>
              <span>
                <Icon name="moon" size={13} />
                {app.definition.options.keepAlive
                  ? "起動を維持"
                  : app.runtime?.activeRequests
                    ? "アクセス中"
                    : idleRemaining !== null
                      ? `停止まで約${idleRemaining}分`
                      : "自動停止"}
              </span>
              <button
                className={`keep-alive ${app.definition.options.keepAlive ? "active" : ""}`}
                disabled={isBusy}
                aria-pressed={app.definition.options.keepAlive}
                onClick={() => onKeepAlive(app)}
              >
                <Icon name="pin" size={13} />
                起動を維持
              </button>
            </>
          ) : null}
        </div>
        {app.runtime?.lastError && (
          <button className="card-error" onClick={() => onInspect(app, "logs")}>
            <Icon name="alert" size={14} />
            <span>{app.runtime.lastError}</span>
            <Icon name="chevron" size={14} />
          </button>
        )}
        {app.runtime?.idleReason && (
          <p className="idle-reason">{app.runtime.idleReason}</p>
        )}
      </div>
      <div className="app-card-actions">
        {app.actions.stop.enabled ? (
          <button
            className="button stop-button"
            disabled={isBusy}
            onClick={() => onAction(app, "stop")}
          >
            <Icon name="stop" size={15} />
            <span>停止</span>
          </button>
        ) : (
          <button
            className="button primary"
            disabled={isBusy || !app.actions.start.enabled}
            title={app.actions.start.reason ?? undefined}
            onClick={() => onAction(app, "start")}
          >
            <Icon name="play" size={15} />
            <span>{isBusy ? "処理中" : "起動"}</span>
          </button>
        )}
        <button
          className="icon-button"
          title="ログ"
          aria-label={`${app.name}のログ`}
          onClick={() => onInspect(app, "logs")}
        >
          <Icon name="log" />
        </button>
        <details className="card-menu">
          <summary className="icon-button" aria-label={`${app.name}の操作`}>
            <Icon name="more" />
          </summary>
          <div className="menu-panel">
            <button onClick={() => onInspect(app, "details")}>
              <Icon name="server" size={15} />
              詳細を見る
            </button>
            <button onClick={() => onEdit(app)}>
              <Icon name="edit" size={15} />
              設定を編集
            </button>
            <button
              disabled={isBusy || !app.actions.restart.enabled}
              onClick={() => onAction(app, "restart")}
            >
              <Icon name="refresh" size={15} />
              再起動
            </button>
            <hr />
            <button disabled={first} onClick={() => onMove(app, -1)}>
              <Icon name="arrow-up" size={15} />
              上へ移動
            </button>
            <button disabled={last} onClick={() => onMove(app, 1)}>
              <Icon name="arrow-down" size={15} />
              下へ移動
            </button>
            <hr />
            <button
              className="danger"
              disabled={
                isBusy ||
                app.status === "online" ||
                app.runtime?.processes.some((p) => p.online)
              }
              onClick={() => onDelete(app)}
            >
              <Icon name="trash" size={15} />
              登録を削除
            </button>
          </div>
        </details>
      </div>
    </article>
  );
}
