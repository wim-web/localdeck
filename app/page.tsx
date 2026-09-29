import { useMemo, useState, useEffect } from "react";
import type { DragEvent } from "react";
import { AppEditor } from "./components/app-editor";
import { AppCard, appPhase } from "./components/app-card";
import { AppInspector } from "./components/app-inspector";
import { CategoryEditor } from "./components/category-editor";
import { CommandPalette } from "./components/command-palette";
import { Icon } from "./components/icon";
import type { IconName } from "./components/icon";
import { createCommandItems } from "./command-items";
import { useLocaldeckController } from "./use-localdeck-controller";
import type { Category, LocalApp } from "./localdeck-types";

const filters: { id: string; label: string; icon: IconName }[] = [
  { id: "all", label: "すべてのアプリ", icon: "grid" },
  { id: "running", label: "稼働中", icon: "play" },
  { id: "waiting", label: "待ち受け", icon: "moon" },
  { id: "stopped", label: "停止中", icon: "stop" },
  { id: "error", label: "エラー", icon: "alert" },
];
function matches(app: LocalApp, filter: string): boolean {
  const phase = appPhase(app);
  if (filter === "all") return true;
  if (filter === "waiting")
    return (
      phase === "stopped" && Boolean(app.definition.options?.wakeOnRequest)
    );
  if (filter === "stopped")
    return phase === "stopped" && !app.definition.options?.wakeOnRequest;
  return phase === filter;
}
export default function Home() {
  const controller = useLocaldeckController();
  const {
    snapshot,
    loading,
    refreshing,
    error,
    notice,
    autoRefresh,
    editorMode,
    form,
    saving,
    commandOpen,
    pendingDelete,
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
    mutate,
  } = controller;
  const [filter, setFilter] = useState("all");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inspector, setInspector] = useState<{
    id: string;
    tab: "details" | "logs";
  } | null>(null);
  const [categoryEditor, setCategoryEditor] = useState<{
    category: Category | null;
  } | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [theme, setTheme] = useState(() =>
    typeof window === "undefined"
      ? "light"
      : (localStorage.getItem("localdeck-theme") ??
        (window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light")),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("localdeck-theme", theme);
  }, [theme]);
  const categories = snapshot?.categories ?? [];
  const selectedCategory = categories.find((c) => c.id === categoryId);
  const filtered = useMemo(
    () =>
      visibleApps.filter((app) => {
        if (
          categoryId !== null &&
          (app.definition.options?.categoryId ?? "") !== categoryId
        )
          return false;
        if (!matches(app, filter)) return false;
        const haystack = [
          app.name,
          app.description,
          app.host,
          app.directory,
          app.definition.lifecycle?.start?.join(" "),
        ]
          .join(" ")
          .toLocaleLowerCase();
        return haystack.includes(query.toLocaleLowerCase().trim());
      }),
    [visibleApps, categoryId, filter, query],
  );
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
  async function move(app: LocalApp, offset: number) {
    const target =
      filtered[filtered.findIndex((item) => item.id === app.id) + offset];
    if (!target) return;
    await reorder(app.id, target.id);
  }
  async function reorder(source: string, target: string) {
    const ids = visibleApps.map((app) => app.id);
    const index = ids.indexOf(source),
      targetIndex = ids.indexOf(target);
    if (index < 0 || targetIndex < 0 || index === targetIndex || pendingDelete)
      return;
    ids.splice(index, 1);
    ids.splice(targetIndex, 0, source);
    await mutate("/api/apps/reorder", { ids });
  }
  function drop(event: DragEvent, target: LocalApp) {
    event.preventDefault();
    void reorder(event.dataTransfer.getData("text/localdeck-app"), target.id);
  }
  const inspectedApp = snapshot?.apps.find((app) => app.id === inspector?.id);
  const title =
    categoryId === ""
      ? "未分類"
      : (selectedCategory?.name ??
        filters.find((item) => item.id === filter)?.label ??
        "すべてのアプリ");
  return (
    <div className="deck-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <button
          type="button"
          className="brand"
          onClick={() => {
            setFilter("all");
            setCategoryId(null);
            setMobileNav(false);
          }}
        >
          <span className="brand-mark">
            <Icon name="grid" size={23} />
          </span>
          <span>
            <strong>Localdeck</strong>
            <small>ローカルアプリ管理</small>
          </span>
        </button>
        <div className="sidebar-scroll">
          <nav className="main-navigation" aria-label="アプリの絞り込み">
            {filters.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${filter === item.id && categoryId === null ? "active" : ""}`}
                onClick={() => {
                  setFilter(item.id);
                  setCategoryId(null);
                  setMobileNav(false);
                }}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                <small>
                  {visibleApps.filter((app) => matches(app, item.id)).length}
                </small>
              </button>
            ))}
          </nav>
          <div className="sidebar-section-title">
            <span>カテゴリ</span>
            <button
              className="icon-button small"
              aria-label="カテゴリを追加"
              onClick={() => setCategoryEditor({ category: null })}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          <nav className="category-navigation" aria-label="カテゴリ">
            {categories.map((category) => (
              <div className="category-nav-row" key={category.id}>
                <button
                  className={`nav-item ${categoryId === category.id ? "active" : ""}`}
                  onClick={() => {
                    setCategoryId(category.id);
                    setFilter("all");
                    setMobileNav(false);
                  }}
                >
                  <span className={`category-dot color-${category.color}`} />
                  <span>{category.name}</span>
                  <small>
                    {
                      visibleApps.filter(
                        (app) =>
                          app.definition.options?.categoryId === category.id,
                      ).length
                    }
                  </small>
                </button>
                <button
                  className="category-edit icon-button small"
                  aria-label={`${category.name}を編集`}
                  onClick={() => setCategoryEditor({ category })}
                >
                  <Icon name="edit" size={13} />
                </button>
              </div>
            ))}
            <button
              className={`nav-item ${categoryId === "" ? "active" : ""}`}
              onClick={() => {
                setCategoryId("");
                setFilter("all");
                setMobileNav(false);
              }}
            >
              <Icon name="folder" size={17} />
              <span>未分類</span>
              <small>
                {
                  visibleApps.filter(
                    (app) => !app.definition.options?.categoryId,
                  ).length
                }
              </small>
            </button>
          </nav>
        </div>
        <div className="sidebar-bottom">
          <div className="proxy-card">
            <div>
              <span
                className={`status-dot ${snapshot?.caddy.connected ? "online" : "offline"}`}
              />
              <strong>リバースプロキシ</strong>
            </div>
            <p>HTTPS · *.localhost</p>
            <small>
              {snapshot?.caddy.connected
                ? snapshot.caddy.inSync
                  ? "すべてのルートが同期されています"
                  : "設定の同期が必要です"
                : "Caddyへの接続を確認してください"}
            </small>
            <footer>
              <span>
                {snapshot?.caddy.connected
                  ? `${snapshot.caddy.routeCount} routes`
                  : "未接続"}
              </span>
              <button
                className="button quiet"
                disabled={refreshing}
                onClick={() => void handleCaddySync()}
              >
                <Icon name="refresh" size={13} />
                同期
              </button>
            </footer>
          </div>
          <div className="sidebar-tools">
            <button
              className="icon-button"
              aria-label={
                theme === "dark"
                  ? "ライトテーマに切り替え"
                  : "ダークテーマに切り替え"
              }
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <span>Local workspace</span>
            <button
              className="icon-button"
              aria-label="コマンドを開く"
              onClick={openCommandPalette}
            >
              <Icon name="settings" size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="toolbar">
          <button
            className="icon-button mobile-menu"
            aria-label="メニュー"
            aria-expanded={mobileNav}
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Icon name="grid" />
          </button>
          <div className="search-field">
            <Icon name="search" size={19} />
            <input
              type="search"
              aria-label="アプリを検索"
              placeholder="名前・フォルダ・コマンドで探す"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              className="keyboard-hint"
              onClick={openCommandPalette}
              aria-label="コマンドパレットを開く"
            >
              ⌘ K
            </button>
          </div>
          <button className="button primary add-app" onClick={openCreateEditor}>
            <Icon name="plus" />
            <span>アプリを登録</span>
          </button>
        </header>
        <div className="board">
          <header className="board-heading">
            <div>
              <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
              <h1>
                {title}
                <span>{filtered.length}</span>
              </h1>
              <p>起動・ログ・ローカルURLをまとめて管理。</p>
            </div>
            <div className="board-controls">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(event) =>
                    setAutoRefreshEnabled(event.target.checked)
                  }
                />
                自動更新
              </label>
              <button
                className={`icon-button ${refreshing ? "spinning" : ""}`}
                aria-label="状態を更新"
                disabled={refreshing}
                onClick={() => void loadSnapshot(false)}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </header>
          {error && (
            <div className="inline-error" role="alert">
              <Icon name="alert" />
              <p>{error}</p>
              <button
                className="button secondary"
                onClick={() => void loadSnapshot(false)}
              >
                再試行
              </button>
            </div>
          )}
          <section
            className="app-board"
            aria-label="アプリ一覧"
            aria-busy={loading}
          >
            {filtered.map((app, index) => (
              <AppCard
                key={app.id}
                app={app}
                checkedAt={snapshot!.generatedAt}
                busy={busyAppIds.has(app.id)}
                category={categories.find(
                  (category) =>
                    category.id === app.definition.options?.categoryId,
                )}
                onAction={(app, action) => void handleAction(app, action)}
                onEdit={openEditEditor}
                onInspect={(app, tab) => setInspector({ id: app.id, tab })}
                onDelete={handleDeleteApp}
                onKeepAlive={(app) =>
                  void mutate(`/api/apps/${app.id}/keep-alive`, {
                    enabled: !app.definition.options?.keepAlive,
                  })
                }
                onMove={(app, offset) => void move(app, offset)}
                onDragStart={(event, app) => {
                  event.dataTransfer.setData("text/localdeck-app", app.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDrop={drop}
                first={index === 0}
                last={index === filtered.length - 1}
              />
            ))}
            {loading && !snapshot && (
              <div className="empty-state">
                <span className="spinner" />
                <h2>ワークスペースを読み込み中</h2>
                <p>アプリの状態を確認しています。</p>
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="empty-state">
                <span className="empty-icon">
                  <Icon name={query ? "search" : "grid"} size={30} />
                </span>
                <h2>
                  {visibleApps.length
                    ? "該当するアプリがありません"
                    : "ツールをひとつ、追加しましょう"}
                </h2>
                <p>
                  {visibleApps.length
                    ? "検索条件やカテゴリを変えてみてください。"
                    : "起動、ログ、ローカルURLをこの場所にまとめられます。"}
                </p>
                {!visibleApps.length && (
                  <button className="button primary" onClick={openCreateEditor}>
                    <Icon name="plus" />
                    アプリを登録
                  </button>
                )}
              </div>
            )}
          </section>
          <footer className="board-footer">
            <span>
              <span className="status-dot online" />
              {snapshot?.summary.online ?? 0} 件が稼働中
            </span>
            <span>⌘ K ですばやく操作</span>
          </footer>
        </div>
      </main>
      {editorMode && (
        <AppEditor
          form={form}
          editing={editorMode === "edit"}
          saving={saving}
          error={notice?.tone === "error" ? notice.text : null}
          categories={categories}
          onChange={updateForm}
          onCancel={closeEditor}
          onSubmit={(event) => void handleSaveApp(event)}
        />
      )}
      {inspector && inspectedApp && (
        <AppInspector
          key={inspector.id + inspector.tab}
          app={inspectedApp}
          initialTab={inspector.tab}
          onClose={() => setInspector(null)}
        />
      )}
      {categoryEditor && (
        <CategoryEditor
          category={categoryEditor.category}
          onClose={() => setCategoryEditor(null)}
          onSave={(category) => mutate("/api/categories", category)}
          onDelete={(id) => mutate(`/api/categories/${id}`, {}, "DELETE")}
        />
      )}
      {commandOpen && (
        <CommandPalette
          open
          commands={commands}
          onClose={closeCommandPalette}
        />
      )}
      {(notice || pendingDelete) && (
        <div
          className={`toast ${notice?.tone ?? ""}`}
          role={notice?.tone === "error" ? "alert" : "status"}
        >
          {pendingDelete ? (
            <>
              <span>{pendingDelete.app.name}の登録を削除します</span>
              <button onClick={undoDelete}>取り消す</button>
            </>
          ) : (
            <>
              <span>{notice?.text}</span>
              <button
                className="icon-button"
                aria-label="通知を閉じる"
                onClick={clearNotice}
              >
                <Icon name="close" size={16} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
