import type { FormEvent } from "react";

import type { FormState } from "../localdeck-types";

type AppEditorProps = {
  form: FormState;
  editing: boolean;
  saving: boolean;
  onChange: (field: keyof FormState, value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function AppEditor({
  form,
  editing,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: AppEditorProps) {
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
            <p className="form-span-2 form-note">
              ログはLocaldeck側の <code>logs/apps/&lt;アプリID&gt;.log</code> に保存します。
            </p>
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
