import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { moveCommandSelection, resolveActiveCommandId } from "../command-selection";
import type { CommandItem } from "../localdeck-types";

type CommandPaletteProps = {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
};

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ja-JP");
    if (!normalized) return commands;
    return commands.filter((command) =>
      (command.label + " " + command.keywords).toLocaleLowerCase("ja-JP").includes(normalized),
    );
  }, [commands, query]);
  const resolvedActiveCommandId = resolveActiveCommandId(filteredCommands, activeCommandId);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.getElementById("app-workbench")?.setAttribute("inert", "");
    const frame = window.requestAnimationFrame(() => {
      setQuery("");
      setActiveCommandId(null);
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
    setActiveCommandId(
      moveCommandSelection(filteredCommands, resolvedActiveCommandId, direction),
    );
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
      const command = filteredCommands.find((item) => item.id === resolvedActiveCommandId);
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
              setActiveCommandId(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="アプリ名または操作"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={
              resolvedActiveCommandId ? "command-" + resolvedActiveCommandId : undefined
            }
          />
        </label>
        <p className="command-count" aria-live="polite">
          {filteredCommands.length}件
        </p>
        <div className="command-results" id="command-results" role="listbox">
          {filteredCommands.map((command) => (
            <button
              id={"command-" + command.id}
              key={command.id}
              className={
                "command-item" +
                (command.id === resolvedActiveCommandId ? " is-active" : "") +
                (command.tone === "danger" ? " command-item--danger" : "")
              }
              type="button"
              role="option"
              aria-selected={command.id === resolvedActiveCommandId}
              disabled={command.disabled}
              onMouseMove={() => setActiveCommandId(command.id)}
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
