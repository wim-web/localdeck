import type { AppDefinition, FormState, LifecycleDefinition } from "./localdeck-types";

export const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  description: "",
  host: "",
  upstream: "127.0.0.1:",
  directory: "",
  requiredEnvironment: "",
  strategy: "none",
  startCommand: "",
  restartCommand: "",
  stopCommand: "",
  timeoutMs: "120000",
  startTimeoutMs: "30000",
  stopTimeoutMs: "15000",
  headerUpHost: "",
};

function commandToText(command?: string[] | null) {
  return command?.join("\n") ?? "";
}

function textToCommand(value: string) {
  const args = value.split("\n").map((item) => item.trim()).filter(Boolean);
  return args.length ? args : null;
}

export function definitionToForm(app: AppDefinition): FormState {
  const lifecycle = app.lifecycle;
  return {
    ...EMPTY_FORM,
    id: app.id,
    name: app.name,
    description: app.description,
    host: app.host,
    upstream: app.upstream,
    directory: app.directory ?? "",
    requiredEnvironment: app.requiredEnvironment.join(", "),
    strategy: lifecycle?.strategy ?? "none",
    startCommand: commandToText(lifecycle?.start),
    restartCommand: lifecycle?.strategy === "commands" ? commandToText(lifecycle.restart) : "",
    stopCommand: lifecycle?.strategy === "commands" ? commandToText(lifecycle.stop) : "",
    timeoutMs: lifecycle?.strategy === "commands" ? String(lifecycle.timeoutMs) : "120000",
    startTimeoutMs:
      lifecycle?.strategy === "process" ? String(lifecycle.startTimeoutMs) : "30000",
    stopTimeoutMs:
      lifecycle?.strategy === "process" ? String(lifecycle.stopTimeoutMs) : "15000",
    headerUpHost: app.proxy.headerUpHost ?? "",
  };
}

export function formToDefinition(form: FormState): AppDefinition {
  let lifecycle: LifecycleDefinition = null;
  if (form.strategy === "commands") {
    lifecycle = {
      strategy: "commands",
      start: textToCommand(form.startCommand),
      restart: textToCommand(form.restartCommand),
      stop: textToCommand(form.stopCommand),
      timeoutMs: Number(form.timeoutMs),
    };
  } else if (form.strategy === "process") {
    lifecycle = {
      strategy: "process",
      start: textToCommand(form.startCommand) ?? [],
      startTimeoutMs: Number(form.startTimeoutMs),
      stopTimeoutMs: Number(form.stopTimeoutMs),
    };
  }

  return {
    id: form.id,
    name: form.name,
    description: form.description,
    host: form.host,
    upstream: form.upstream,
    directory: form.directory || null,
    requiredEnvironment: form.requiredEnvironment
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter(Boolean),
    lifecycle,
    proxy: form.headerUpHost ? { headerUpHost: form.headerUpHost } : {},
  };
}
