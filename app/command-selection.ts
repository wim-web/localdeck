import type { CommandItem } from "./localdeck-types";

export function resolveActiveCommandId(
  commands: CommandItem[],
  requestedId: string | null,
): string | null {
  if (commands.some((command) => command.id === requestedId && !command.disabled)) {
    return requestedId;
  }
  return commands.find((command) => !command.disabled)?.id ?? null;
}

export function moveCommandSelection(
  commands: CommandItem[],
  activeId: string | null,
  direction: 1 | -1,
): string | null {
  if (commands.length === 0) return null;
  const activeIndex = commands.findIndex((command) => command.id === activeId);
  let next = activeIndex;
  for (let attempts = 0; attempts < commands.length; attempts += 1) {
    next = activeIndex < 0 && attempts === 0
      ? direction === 1 ? 0 : commands.length - 1
      : (next + direction + commands.length) % commands.length;
    if (!commands[next]?.disabled) return commands[next].id;
  }
  return null;
}
