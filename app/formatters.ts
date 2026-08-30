import type { ActionName, LocalApp } from "./localdeck-types";

export function formatCheckedAt(value?: string) {
  if (!value) return "未取得";
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function shortenPath(value: string | null) {
  if (!value) return "—";
  return value.replace(/^\/Users\/[^/]+/, "~");
}

export function actionLabel(action: ActionName) {
  if (action === "start") return "起動";
  if (action === "restart") return "再起動";
  return "停止";
}

export function statusLabel(status: LocalApp["status"]) {
  if (status === "online") return "稼働中";
  if (status === "offline") return "停止中";
  return "不明";
}
