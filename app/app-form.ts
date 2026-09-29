import type {
  AppDefinition,
  FormState,
  LifecycleDefinition,
} from "./localdeck-types";

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
  categoryId: "",
  portMode: "fixed",
  portEnvironment: "PORT",
  environment: "",
  backends: [],
  wakeOnRequest: false,
  idleStopMinutes: "0",
  activityPath: "",
  requestOnlyIdle: false,
  keepAlive: false,
};

export function commandToText(command?: string[] | null) {
  return (
    command
      ?.map((arg) => (/^[^\s"'\\]+$/.test(arg) ? arg : JSON.stringify(arg)))
      .join(" ") ?? ""
  );
}

export function textToCommand(value: string): string[] | null {
  const args: string[] = [];
  let current = "",
    quote = "",
    escaped = false,
    started = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quote || escaped)
    throw new Error("コマンドの引用符・バックスラッシュを閉じてください");
  if (started) args.push(current);
  return args.length ? args : null;
}

export function parseEnvironment(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const index = line.indexOf("=");
        if (index < 1)
          throw new Error("環境変数は NAME=value の形式で入力してください");
        return [line.slice(0, index).trim(), line.slice(index + 1)];
      }),
  );
}
const environmentText = (values: Record<string, string> = {}) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

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
    restartCommand:
      lifecycle?.strategy === "commands"
        ? commandToText(lifecycle.restart)
        : "",
    stopCommand:
      lifecycle?.strategy === "commands" ? commandToText(lifecycle.stop) : "",
    timeoutMs:
      lifecycle?.strategy === "commands"
        ? String(lifecycle.timeoutMs)
        : "120000",
    startTimeoutMs:
      lifecycle?.strategy === "process"
        ? String(lifecycle.startTimeoutMs)
        : "30000",
    stopTimeoutMs:
      lifecycle?.strategy === "process"
        ? String(lifecycle.stopTimeoutMs)
        : "15000",
    headerUpHost: app.proxy.headerUpHost ?? "",
    categoryId: app.options?.categoryId ?? "",
    portMode: app.options?.port.mode ?? "fixed",
    portEnvironment: app.options?.port.environment ?? "",
    environment: environmentText(app.options?.environment),
    backends: (app.options?.backends ?? []).map((backend) => ({
      id: backend.id,
      name: backend.name,
      directory: backend.directory,
      command: commandToText(backend.start),
      port: String(backend.port),
      portMode: backend.portSettings.mode,
      portEnvironment: backend.portSettings.environment,
      environment: environmentText(backend.environment),
    })),
    wakeOnRequest: app.options?.wakeOnRequest ?? false,
    idleStopMinutes: String(app.options?.idleStopMinutes ?? 0),
    activityPath: app.options?.activityPath ?? "",
    requestOnlyIdle: app.options?.requestOnlyIdle ?? false,
    keepAlive: app.options?.keepAlive ?? false,
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
    options: {
      categoryId: form.categoryId || null,
      port: { mode: form.portMode, environment: form.portEnvironment },
      environment: parseEnvironment(form.environment),
      backends: form.backends.map((backend) => ({
        id: backend.id,
        name: backend.name,
        directory: backend.directory || form.directory,
        start: textToCommand(backend.command) ?? [],
        port: Number(backend.port),
        portSettings: {
          mode: backend.portMode,
          environment: backend.portEnvironment,
        },
        environment: parseEnvironment(backend.environment),
      })),
      wakeOnRequest: form.wakeOnRequest,
      idleStopMinutes: Number(form.idleStopMinutes),
      activityPath: form.activityPath,
      requestOnlyIdle: form.requestOnlyIdle,
      keepAlive: form.keepAlive,
    },
  };
}
