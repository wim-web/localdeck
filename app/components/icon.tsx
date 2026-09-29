export type IconName =
  | "grid"
  | "play"
  | "stop"
  | "moon"
  | "search"
  | "plus"
  | "settings"
  | "chevron"
  | "log"
  | "edit"
  | "more"
  | "external"
  | "refresh"
  | "pin"
  | "close"
  | "folder"
  | "check"
  | "sun"
  | "arrow-up"
  | "arrow-down"
  | "grip"
  | "alert"
  | "copy"
  | "trash"
  | "server";
const paths: Record<IconName, string> = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  play: "m8 4 12 8-12 8z",
  stop: "M5 5h14v14H5z",
  moon: "M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  plus: "M12 5v14 M5 12h14",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  chevron: "m9 5 7 7-7 7",
  log: "M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5",
  edit: "m15 5 4 4 M4 20l4-1L21 6l-4-4L4 15z",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  external: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
  refresh: "M20 7v5h-5 M20 12a8 8 0 1 0-2 6",
  pin: "m9 3 6 0-1 5 4 5H6l4-5z M12 13v8",
  close: "m6 6 12 12 M6 18 18 6",
  folder: "M3 5h6l2 3h10v12H3z",
  check: "m5 12 4 4L19 6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  "arrow-up": "m5 12 7-7 7 7 M12 5v15",
  "arrow-down": "m5 12 7 7 7-7 M12 19V4",
  grip: "M9 5h.01 M15 5h.01 M9 12h.01 M15 12h.01 M9 19h.01 M15 19h.01",
  alert: "m12 3 10 18H2z M12 9v4 M12 17h.01",
  copy: "M8 8h13v13H8z M16 8V3H3v13h5",
  trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
  server: "M3 3h18v7H3z M3 14h18v7H3z M7 6h.01 M7 17h.01",
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" || name === "grip" ? 3 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
