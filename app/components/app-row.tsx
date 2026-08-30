import { actionLabel, shortenPath, statusLabel } from "../formatters";
import type { ActionName, LocalApp } from "../localdeck-types";

type AppRowProps = {
  app: LocalApp;
  busy: boolean;
  copied: string | null;
  deletePending: boolean;
  onAction: (app: LocalApp, action: ActionName) => void;
  onCopy: (key: string, value: string) => void;
  onEdit: (app: LocalApp) => void;
  onDelete: (app: LocalApp) => void;
};

export function AppRow({
  app,
  busy,
  copied,
  deletePending,
  onAction,
  onCopy,
  onEdit,
  onDelete,
}: AppRowProps) {
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
