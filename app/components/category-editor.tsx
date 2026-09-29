import { useState } from "react";
import type { Category } from "../localdeck-types";
import { Icon } from "./icon";
import { Modal } from "./modal";

export function CategoryEditor({
  category,
  onSave,
  onDelete,
  onClose,
}: {
  category: Category | null;
  onSave(category: Category): Promise<boolean>;
  onDelete(id: string): Promise<boolean>;
  onClose(): void;
}) {
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState(category?.color ?? "blue");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <Modal
      title={category ? "カテゴリの編集" : "カテゴリを追加"}
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          if (
            await onSave({
              id: category?.id ?? `category-${crypto.randomUUID()}`,
              name,
              color,
            })
          )
            onClose();
          else
            setError(
              "カテゴリを保存できませんでした。名前や接続状態を確認してください。",
            );
          setSaving(false);
        }}
      >
        <div className="modal-body">
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <label>
            <span>カテゴリ名</span>
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="開発ツール"
            />
          </label>
          <fieldset className="color-picker">
            <legend>色</legend>
            {["blue", "purple", "green", "orange", "pink", "gray"].map(
              (value) => (
                <button
                  key={value}
                  type="button"
                  className={`color-swatch color-${value}`}
                  aria-label={value}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                >
                  {color === value && <Icon name="check" size={17} />}
                </button>
              ),
            )}
          </fieldset>
          {confirmDelete && (
            <p className="muted-panel">
              このカテゴリを削除します。含まれるアプリは未分類になります。
            </p>
          )}
        </div>
        <footer className="modal-footer">
          {category && (
            <button
              className="button danger quiet footer-start"
              type="button"
              disabled={saving}
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                setSaving(true);
                if (await onDelete(category.id)) onClose();
                setSaving(false);
              }}
            >
              {confirmDelete ? "削除を確定" : "カテゴリを削除"}
            </button>
          )}
          <button className="button primary" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
