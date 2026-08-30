import { AppEditor } from "./components/app-editor";
import { AppRow } from "./components/app-row";
import { CommandPalette } from "./components/command-palette";
import { createCommandItems } from "./command-items";
import { formatCheckedAt } from "./formatters";
import { useLocaldeckController } from "./use-localdeck-controller";

export default function Home() {
  const {
    snapshot,
    loading,
    refreshing,
    error,
    notice,
    autoRefresh,
    copied,
    editorMode,
    form,
    saving,
    commandOpen,
    pendingDelete,
    healthLabel,
    visibleApps,
    busyAppIds,
    loadSnapshot,
    handleAction,
    openCreateEditor,
    openEditEditor,
    closeEditor,
    updateForm,
    handleSaveApp,
    handleDeleteApp,
    undoDelete,
    handleCaddySync,
    handleCopy,
    setAutoRefreshEnabled,
    openCommandPalette,
    closeCommandPalette,
    clearNotice,
  } = useLocaldeckController();

  const commands = createCommandItems({
    snapshot,
    refreshing,
    autoRefresh,
    busyAppIds,
    pendingDeleteAppId: pendingDelete?.app.id ?? null,
    onRegister: openCreateEditor,
    onRefresh: () => void loadSnapshot(false),
    onAutoRefreshChange: setAutoRefreshEnabled,
    onCaddySync: () => void handleCaddySync(),
    onCopy: (key, value) => void handleCopy(key, value),
    onEdit: openEditEditor,
    onAction: (app, action) => void handleAction(app, action),
    onDelete: handleDeleteApp,
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
              onClick={openCommandPalette}
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
                onChange={(event) => setAutoRefreshEnabled(event.target.checked)}
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
              onCancel={closeEditor}
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
                busy={busyAppIds.has(app.id)}
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
              <button className="button button--notice-close" type="button" onClick={clearNotice}>
                閉じる
              </button>
            </div>
          )}
        </div>
      </main>

      <CommandPalette
        open={commandOpen}
        commands={commands}
        onClose={closeCommandPalette}
      />
    </>
  );
}
