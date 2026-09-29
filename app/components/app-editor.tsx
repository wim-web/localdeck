import { useState } from "react";
import type { FormEvent } from "react";
import type { BackendForm, Category, FormState } from "../localdeck-types";
import { Icon } from "./icon";
import { Modal } from "./modal";

type Props = {
  form: FormState;
  editing: boolean;
  saving: boolean;
  error?: string | null;
  categories?: Category[];
  onChange<K extends keyof FormState>(field: K, value: FormState[K]): void;
  onCancel(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
};
export function AppEditor({
  form,
  editing,
  saving,
  error,
  categories = [],
  onChange,
  onCancel,
  onSubmit,
}: Props) {
  const [tab, setTab] = useState("basic");
  function updateBackend(index: number, patch: Partial<BackendForm>) {
    onChange(
      "backends",
      form.backends.map((backend, i) =>
        i === index ? { ...backend, ...patch } : backend,
      ),
    );
  }
  return (
    <Modal
      title={editing ? "アプリの設定" : "アプリを登録"}
      subtitle={editing ? form.name : "いつものツールを、ひとつの場所に。"}
      onClose={onCancel}
      wide
    >
      <form
        className="app-editor"
        onSubmit={onSubmit}
        onInvalidCapture={(event) => {
          const section = (event.target as HTMLElement).closest(
            "section[data-tab]",
          );
          if (section) setTab(section.getAttribute("data-tab")!);
        }}
      >
        <nav className="editor-tabs" aria-label="設定のセクション">
          {[
            ["basic", "基本設定"],
            ["process", "起動とポート"],
            ["backends", "バックエンド"],
            ["automation", "自動起動・停止"],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
            >
              {label}
              {key === "backends" && form.backends.length > 0 && (
                <span className="small-count">{form.backends.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="modal-body editor-body">
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <section
            data-tab="basic"
            hidden={tab !== "basic"}
            className="form-grid"
          >
            <label>
              <span>アプリ名</span>
              <input
                required
                value={form.name}
                onChange={(e) => onChange("name", e.target.value)}
                placeholder="My workspace"
              />
            </label>
            <label>
              <span>アプリID</span>
              <input
                required
                disabled={editing}
                value={form.id}
                onChange={(e) => onChange("id", e.target.value)}
                placeholder="my-workspace"
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
              />
            </label>
            <label className="form-span-2">
              <span>
                説明 <small>任意</small>
              </span>
              <input
                value={form.description}
                onChange={(e) => onChange("description", e.target.value)}
                placeholder="このアプリでできること"
              />
            </label>
            <label>
              <span>ローカルドメイン</span>
              <input
                required
                value={form.host}
                onChange={(e) => onChange("host", e.target.value)}
                placeholder="workspace.localhost"
              />
              <small>いつも同じURLからアクセスできます。</small>
            </label>
            <label>
              <span>カテゴリ</span>
              <select
                value={form.categoryId}
                onChange={(e) => onChange("categoryId", e.target.value)}
              >
                <option value="">未分類</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-span-2">
              <span>作業フォルダ</span>
              <input
                value={form.directory}
                onChange={(e) => onChange("directory", e.target.value)}
                placeholder="/Users/you/projects/my-app"
              />
              <small>このフォルダのfaviconを自動で表示します。</small>
            </label>
            <label>
              <span>
                転送先のHostヘッダー <small>任意</small>
              </span>
              <input
                value={form.headerUpHost}
                onChange={(e) => onChange("headerUpHost", e.target.value)}
                placeholder="元のドメインを使用"
              />
            </label>
          </section>
          <section
            data-tab="process"
            hidden={tab !== "process"}
            className="form-grid"
          >
            <label>
              <span>起動方法</span>
              <select
                value={form.strategy}
                onChange={(e) =>
                  onChange("strategy", e.target.value as FormState["strategy"])
                }
              >
                <option value="none">状態の確認のみ</option>
                <option value="process">コマンドで起動</option>
                <option value="commands">起動・停止を別のコマンドで管理</option>
              </select>
            </label>
            <label>
              <span>ポートの割り当て</span>
              <select
                value={form.portMode}
                disabled={form.strategy !== "process"}
                onChange={(e) =>
                  onChange("portMode", e.target.value as "fixed" | "auto")
                }
              >
                <option value="fixed">固定ポート</option>
                <option value="auto">空きポートを自動で選ぶ</option>
              </select>
            </label>
            <label>
              <span>
                {form.portMode === "auto" ? "優先する転送先" : "転送先"}
              </span>
              <input
                required
                value={form.upstream}
                onChange={(e) => onChange("upstream", e.target.value)}
                placeholder="127.0.0.1:3000"
              />
              <small>
                {form.portMode === "auto"
                  ? "使用中なら別のポートを割り当てます。"
                  : "アプリが待ち受けるアドレスとポート。"}
              </small>
            </label>
            <label>
              <span>ポートを渡す環境変数</span>
              <input
                value={form.portEnvironment}
                onChange={(e) => onChange("portEnvironment", e.target.value)}
                placeholder="PORT"
              />
              <small>
                空欄なら渡しません。指定する場合はアプリ側でこの値を読む必要があります。
              </small>
            </label>
            {form.strategy !== "none" && (
              <label className="form-span-2">
                <span>起動コマンド</span>
                <textarea
                  value={form.startCommand}
                  onChange={(e) => onChange("startCommand", e.target.value)}
                  placeholder="npm run dev -- --port {port} --strictPort"
                  rows={2}
                />
                <small>
                  <code>{"{port}"}</code>{" "}
                  を割り当てたポートに置換します。空白を含む引数は引用符で囲みます。
                </small>
              </label>
            )}
            {form.strategy === "commands" && (
              <>
                <label>
                  <span>再起動コマンド</span>
                  <input
                    value={form.restartCommand}
                    onChange={(e) => onChange("restartCommand", e.target.value)}
                    placeholder="bin/server restart"
                  />
                </label>
                <label>
                  <span>停止コマンド</span>
                  <input
                    value={form.stopCommand}
                    onChange={(e) => onChange("stopCommand", e.target.value)}
                    placeholder="bin/server stop"
                  />
                </label>
                <label>
                  <span>操作タイムアウト（ms）</span>
                  <input
                    type="number"
                    min="100"
                    max="3600000"
                    value={form.timeoutMs}
                    onChange={(e) => onChange("timeoutMs", e.target.value)}
                  />
                </label>
              </>
            )}
            <label className="form-span-2">
              <span>
                環境変数 <small>1行にひとつ</small>
              </span>
              <textarea
                rows={3}
                value={form.environment}
                onChange={(e) => onChange("environment", e.target.value)}
                placeholder={
                  "NODE_ENV=development\nAPI_URL=http://127.0.0.1:{backendPort:api}"
                }
              />
              <small>
                設定に保存されます。秘密の値は起動元の環境変数で渡してください。
              </small>
            </label>
            <label className="form-span-2">
              <span>
                起動に必要な環境変数名 <small>任意</small>
              </span>
              <input
                value={form.requiredEnvironment}
                onChange={(e) =>
                  onChange("requiredEnvironment", e.target.value)
                }
                placeholder="API_KEY, OTHER_KEY"
              />
            </label>
            {form.strategy === "process" && (
              <>
                <label>
                  <span>起動待ち（ms）</span>
                  <input
                    type="number"
                    min="100"
                    max="3600000"
                    value={form.startTimeoutMs}
                    onChange={(e) => onChange("startTimeoutMs", e.target.value)}
                  />
                </label>
                <label>
                  <span>停止待ち（ms）</span>
                  <input
                    type="number"
                    min="100"
                    max="3600000"
                    value={form.stopTimeoutMs}
                    onChange={(e) => onChange("stopTimeoutMs", e.target.value)}
                  />
                </label>
              </>
            )}
          </section>
          <section data-tab="backends" hidden={tab !== "backends"}>
            <div className="section-intro">
              <h3>一緒に動かすプロセス</h3>
              <p>
                バックエンドの起動を確認してから、メインのアプリを起動します。
              </p>
            </div>
            {form.strategy !== "process" ? (
              <p className="muted-panel">
                「起動とポート」で「コマンドで起動」を選ぶと追加できます。
              </p>
            ) : (
              <>
                {form.backends.map((backend, index) => (
                  <fieldset key={index} className="backend-form">
                    <legend>バックエンド {index + 1}</legend>
                    <div className="form-grid">
                      <label>
                        <span>名前</span>
                        <input
                          value={backend.name}
                          onChange={(e) =>
                            updateBackend(index, { name: e.target.value })
                          }
                          placeholder="API server"
                        />
                      </label>
                      <label>
                        <span>ID</span>
                        <input
                          value={backend.id}
                          onChange={(e) =>
                            updateBackend(index, { id: e.target.value })
                          }
                          placeholder="api"
                        />
                      </label>
                      <label className="form-span-2">
                        <span>作業フォルダ</span>
                        <input
                          value={backend.directory}
                          onChange={(e) =>
                            updateBackend(index, { directory: e.target.value })
                          }
                          placeholder={form.directory || "メインと同じフォルダ"}
                        />
                      </label>
                      <label className="form-span-2">
                        <span>起動コマンド</span>
                        <textarea
                          rows={2}
                          value={backend.command}
                          onChange={(e) =>
                            updateBackend(index, { command: e.target.value })
                          }
                          placeholder="go run . --port {backendPort:api}"
                        />
                        <small>
                          このプロセスのポートは{" "}
                          <code>{`{backendPort:${backend.id || "api"}}`}</code>{" "}
                          で参照できます。
                        </small>
                      </label>
                      <label>
                        <span>ポート</span>
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={backend.port}
                          onChange={(e) =>
                            updateBackend(index, { port: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>割り当て</span>
                        <select
                          value={backend.portMode}
                          onChange={(e) =>
                            updateBackend(index, {
                              portMode: e.target.value as "fixed" | "auto",
                            })
                          }
                        >
                          <option value="fixed">固定</option>
                          <option value="auto">自動</option>
                        </select>
                      </label>
                      <label>
                        <span>ポートを渡す環境変数</span>
                        <input
                          value={backend.portEnvironment}
                          onChange={(e) =>
                            updateBackend(index, {
                              portEnvironment: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="form-span-2">
                        <span>環境変数</span>
                        <textarea
                          rows={2}
                          value={backend.environment}
                          onChange={(e) =>
                            updateBackend(index, {
                              environment: e.target.value,
                            })
                          }
                          placeholder="NAME=value"
                        />
                      </label>
                    </div>
                    <button
                      className="button danger quiet"
                      type="button"
                      onClick={() =>
                        onChange(
                          "backends",
                          form.backends.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Icon name="trash" size={15} />
                      削除
                    </button>
                  </fieldset>
                ))}
                <button
                  className="button secondary"
                  type="button"
                  disabled={form.backends.length >= 12}
                  onClick={() =>
                    onChange("backends", [
                      ...form.backends,
                      {
                        id: `backend-${form.backends.length + 1}`,
                        name: "",
                        directory: "",
                        command: "",
                        port: String(8000 + form.backends.length),
                        portMode: "auto",
                        portEnvironment: "PORT",
                        environment: "",
                      },
                    ])
                  }
                >
                  <Icon name="plus" />
                  バックエンドを追加
                </button>
              </>
            )}
          </section>
          <section
            data-tab="automation"
            hidden={tab !== "automation"}
            className="automation-settings"
          >
            <label className="toggle-row" aria-label="アクセス時に起動">
              <span>
                <strong>アクセス時に起動</strong>
                <p>URLを開くと、停止中のアプリを自動で起動します。</p>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={form.wakeOnRequest}
                onChange={(e) => onChange("wakeOnRequest", e.target.checked)}
              />
            </label>
            <label className="toggle-row" aria-label="起動を維持">
              <span>
                <strong>起動を維持</strong>
                <p>自動停止を一時的に無効にします。</p>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={form.keepAlive}
                onChange={(e) => onChange("keepAlive", e.target.checked)}
              />
            </label>
            <div className="form-grid">
              <label>
                <span>アクセスがないときに停止（分）</span>
                <input
                  type="number"
                  min="0"
                  max="1440"
                  value={form.idleStopMinutes}
                  onChange={(e) => onChange("idleStopMinutes", e.target.value)}
                />
                <small>
                  0で無効。接続中のWebSocketも使用中として扱います。
                </small>
              </label>
            </div>
            {Number(form.idleStopMinutes) > 0 && (
              <div className="idle-guard">
                <h3>処理中のアプリを止めないために</h3>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={form.requestOnlyIdle}
                    onChange={(e) =>
                      onChange("requestOnlyIdle", e.target.checked)
                    }
                  />
                  <span>
                    このアプリはバックグラウンド処理・定期実行を行わない
                  </span>
                </label>
                <label>
                  <span>
                    処理状態の確認パス{form.requestOnlyIdle ? "（任意）" : ""}
                  </span>
                  <input
                    value={form.activityPath}
                    onChange={(e) => onChange("activityPath", e.target.value)}
                    placeholder="/api/activity"
                  />
                  <small>
                    <code>{'{"busy":false}'}</code>{" "}
                    が返った場合だけ停止します。応答なし・エラー時は起動を維持します。定期実行するアプリは自動停止を無効にしてください。
                  </small>
                </label>
              </div>
            )}
          </section>
        </div>
        <footer className="modal-footer">
          <button className="button secondary" type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? "保存中…" : editing ? "変更を保存" : "アプリを登録"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
