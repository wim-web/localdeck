import { actionLabel } from "./formatters";
import type { ActionName, CommandItem, LocalApp, Snapshot } from "./localdeck-types";

type CommandItemOptions = {
  snapshot: Snapshot | null;
  refreshing: boolean;
  autoRefresh: boolean;
  busyAppIds: ReadonlySet<string>;
  pendingDeleteAppId: string | null;
  onRegister: () => void;
  onRefresh: () => void;
  onAutoRefreshChange: (enabled: boolean) => void;
  onCaddySync: () => void;
  onCopy: (key: string, value: string) => void;
  onEdit: (app: LocalApp) => void;
  onAction: (app: LocalApp, action: ActionName) => void;
  onDelete: (app: LocalApp) => void;
};

export function createCommandItems({
  snapshot,
  refreshing,
  autoRefresh,
  busyAppIds,
  pendingDeleteAppId,
  onRegister,
  onRefresh,
  onAutoRefreshChange,
  onCaddySync,
  onCopy,
  onEdit,
  onAction,
  onDelete,
}: CommandItemOptions): CommandItem[] {
  const commands: CommandItem[] = [
    {
      id: "register",
      label: "アプリを登録",
      keywords: "new create registration 新規",
      run: onRegister,
    },
    {
      id: "refresh",
      label: "状態を更新",
      keywords: "refresh reload 再読込",
      disabled: refreshing,
      reason: refreshing ? "更新中" : null,
      run: onRefresh,
    },
    {
      id: "auto-refresh",
      label: autoRefresh ? "自動更新を停止" : "自動更新を開始",
      keywords: "auto refresh polling 5秒",
      run: () => onAutoRefreshChange(!autoRefresh),
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
      run: onCaddySync,
    },
  ];

  for (const app of snapshot?.apps ?? []) {
    if (app.id === pendingDeleteAppId) continue;

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
        run: () => onCopy(app.id + "-url", app.url),
      },
      {
        id: app.id + "-edit",
        label: app.name + "の設定を編集",
        keywords: app.host + " edit configure",
        run: () => onEdit(app),
      },
    );

    const hasRunningProcess = app.status === "online" || Boolean(app.runtime?.processes.some((process) => process.online));
    const actions: ActionName[] = hasRunningProcess ? ["restart", "stop"] : ["start"];
    for (const action of actions) {
      const availability = app.actions[action];
      const busy = busyAppIds.has(app.id);
      commands.push({
        id: app.id + "-" + action,
        label: app.name + "を" + actionLabel(action),
        keywords: app.host + " process " + action,
        disabled: busy || !availability.enabled,
        reason: busy ? "操作中" : availability.reason,
        run: () => onAction(app, action),
      });
    }

    const busy = busyAppIds.has(app.id);
    commands.push({
      id: app.id + "-delete",
      label: app.name + "の登録を削除",
      keywords: app.host + " remove delete",
      disabled: pendingDeleteAppId !== null || busy || hasRunningProcess,
      reason: pendingDeleteAppId !== null ? "別の削除を取り消せます" : busy ? "操作中" : hasRunningProcess ? "先にアプリを停止してください" : null,
      tone: "danger",
      run: () => onDelete(app),
    });
  }

  return commands;
}
