import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFile, mkdir, open, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { parseUpstream } from "./config.js";
import { errorCode, PublicError } from "./errors.js";
import type {
  ActionAvailability,
  ActionName,
  ActionResult,
  AppDefinition,
  InspectedApp,
  ManagedApp,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 700;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT = 12_000;
const managedProcessGroups = new Map<string, number>();
export type InspectionOptions = { includeProcessDetails?: boolean };

type PortStatus = {
  online: boolean;
  latencyMs: number | null;
};

type RunCommandOptions = {
  cwd?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type ExecuteActionOptions = {
  appLogDirectory?: string;
  environment?: NodeJS.ProcessEnv;
};

export function isPortOpen(
  address: string,
  port: number,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<PortStatus> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const socket = net.createConnection({ host: address, port });
    let settled = false;

    const finish = (online: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        online,
        latencyMs: online
          ? Math.max(1, Math.round(performance.now() - startedAt))
          : null,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function runCommand(
  command: string[],
  options: RunCommandOptions = {},
): Promise<{ output: string; code: number }> {
  if (!Array.isArray(command) || command.length === 0) {
    return Promise.reject(new PublicError("実行コマンドが設定されていません"));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd ?? undefined,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;

    const append = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.length > MAX_COMMAND_OUTPUT)
        output = output.slice(-MAX_COMMAND_OUTPUT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new PublicError(
          `コマンドを開始できませんでした: ${error.message}`,
          500,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const trimmed = output.trim();
      if (timedOut) {
        reject(
          new PublicError(
            `操作が ${Math.round(timeoutMs / 1000)} 秒でタイムアウトしました`,
            504,
          ),
        );
      } else if (code !== 0) {
        reject(
          new PublicError(
            trimmed ||
              `コマンドが終了コード ${code ?? signal ?? "不明"} で失敗しました`,
            500,
          ),
        );
      } else {
        resolve({ output: trimmed, code: code ?? 0 });
      }
    });
  });
}

async function listenerPids(port: number): Promise<number[]> {
  try {
    const result = await runCommand(
      ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeoutMs: 3000 },
    );
    return [
      ...new Set(
        result.output.split(/\s+/).map(Number).filter(Number.isInteger),
      ),
    ];
  } catch (error) {
    if (error instanceof PublicError) return [];
    throw error;
  }
}

async function processCwd(pid: number): Promise<string | null> {
  try {
    const result = await runCommand(
      ["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      {
        timeoutMs: 3000,
      },
    );
    const cwdLine = result.output
      .split("\n")
      .find((line) => line.startsWith("n"));
    return cwdLine?.slice(1) ?? null;
  } catch {
    return null;
  }
}

async function processUptime(pid: number): Promise<string | null> {
  try {
    const result = await runCommand(["ps", "-p", String(pid), "-o", "etime="], {
      timeoutMs: 3000,
    });
    return result.output.trim() || null;
  } catch {
    return null;
  }
}

async function processGroupId(pid: number): Promise<number | null> {
  try {
    const result = await runCommand(
      ["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fpg"],
      { timeoutMs: 3000 },
    );
    const value = result.output
      .split("\n")
      .find((line) => line.startsWith("g"))
      ?.slice(1);
    if (!value) return null;
    if (!/^\d+$/.test(value)) return null;
    const processGroup = Number(value);
    return Number.isInteger(processGroup) && processGroup > 1
      ? processGroup
      : null;
  } catch {
    return null;
  }
}

async function normalizedRealpath(
  value: string | null,
): Promise<string | null> {
  if (!value) return null;
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function assertManagedPid(app: ManagedApp, pid: number): Promise<void> {
  const [actualCwd, expectedCwd] = await Promise.all([
    processCwd(pid).then(normalizedRealpath),
    normalizedRealpath(app.directory),
  ]);
  const relativeCwd =
    actualCwd && expectedCwd ? path.relative(expectedCwd, actualCwd) : null;
  const isInsideRegisteredDirectory = Boolean(
    relativeCwd !== null &&
      !path.isAbsolute(relativeCwd) &&
      relativeCwd !== ".." &&
      !relativeCwd.startsWith(`..${path.sep}`),
  );
  if (!isInsideRegisteredDirectory) {
    throw new PublicError(
      `PID ${pid} の作業ディレクトリが登録ディレクトリ配下ではないため、停止を拒否しました`,
      409,
    );
  }
}

async function managedProcessGroupId(
  app: ManagedApp,
  pid: number,
): Promise<number | null> {
  const processGroup = await processGroupId(pid);
  if (!processGroup) return null;
  try {
    await assertManagedPid(app, processGroup);
    return processGroup;
  } catch {
    return null;
  }
}

async function waitForPort(
  address: string,
  port: number,
  expectedOnline: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PortStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const status = await isPortOpen(address, port, 400);
    if (status.online === expectedOnline) return status;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, 250);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
  throw new PublicError(
    expectedOnline
      ? `ポート ${port} が起動待ち時間内に応答しませんでした`
      : `ポート ${port} が停止待ち時間内に閉じませんでした`,
    504,
  );
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new PublicError(`PID ${pid} が停止待ち時間内に終了しませんでした`, 504);
}

async function waitForProcessGroupExit(
  processGroup: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await runCommand(
        ["lsof", "-a", "-g", String(processGroup), "-d", "cwd", "-Fp"],
        { timeoutMs: 3000 },
      );
      if (!result.output.split("\n").some((line) => /^p\d+$/.test(line)))
        return;
    } catch (error) {
      if (error instanceof PublicError) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new PublicError(
    `プロセスグループ ${processGroup} が停止待ち時間内に終了しませんでした`,
    504,
  );
}

function ensureRequiredEnvironment(
  app: ManagedApp,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const missing = (app.requiredEnvironment ?? []).filter(
    (name) => !environment[name],
  );
  if (missing.length > 0) {
    throw new PublicError(
      `Localdeck の起動環境に ${missing.join(", ")} がないため、このアプリを起動できません`,
      409,
    );
  }
}

function resolveAppLogFile(
  app: ManagedApp,
  options: ExecuteActionOptions,
): string {
  const logDirectory = options.appLogDirectory;
  if (!logDirectory || !path.isAbsolute(logDirectory)) {
    throw new PublicError(
      "Localdeckのアプリログ保存先が設定されていません",
      500,
    );
  }
  return path.join(logDirectory, `${app.id}.log`);
}

async function startDetachedProcess(
  app: ManagedApp,
  endpoint: { address: string; port: number },
  options: ExecuteActionOptions,
): Promise<ActionResult> {
  ensureRequiredEnvironment(app, { ...process.env, ...options.environment });
  const current = await isPortOpen(endpoint.address, endpoint.port);
  if (current.online)
    throw new PublicError(`${app.name} はすでに起動しています`, 409);

  const lifecycle = app.lifecycle;
  if (
    !lifecycle ||
    lifecycle.strategy !== "process" ||
    lifecycle.start.length === 0
  ) {
    throw new PublicError(`${app.name} の起動コマンドがありません`, 409);
  }

  const logFile = resolveAppLogFile(app, options);
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(
    logFile,
    `\n[${new Date().toISOString()}] Localdeck start\n`,
    "utf8",
  );
  const handle = await open(logFile, "a");

  let child: ChildProcess | undefined;
  let earlyFailure: Promise<never> | undefined;
  try {
    child = spawn(lifecycle.start[0], lifecycle.start.slice(1), {
      cwd: app.directory ?? undefined,
      env: { ...process.env, ...options.environment },
      detached: true,
      shell: false,
      stdio: ["ignore", handle.fd, handle.fd],
    });
    earlyFailure = new Promise((_, reject) => {
      child?.once("error", (error) =>
        reject(new PublicError(`起動できませんでした: ${error.message}`, 500)),
      );
      child?.once("exit", () => {
        reject(
          new PublicError(`起動直後に終了しました。ログ: ${logFile}`, 500),
        );
      });
    });
    void earlyFailure.catch(() => undefined);
  } finally {
    await handle.close();
  }

  if (!child || !earlyFailure) {
    throw new PublicError("起動プロセスを作成できませんでした", 500);
  }
  const childPid =
    Number.isInteger(child.pid) && (child.pid ?? 0) > 1 ? child.pid! : null;
  if (childPid) managedProcessGroups.set(app.id, childPid);
  child.unref();
  const startupController = new AbortController();

  try {
    await Promise.race([
      waitForPort(
        endpoint.address,
        endpoint.port,
        true,
        lifecycle.startTimeoutMs,
        startupController.signal,
      ),
      earlyFailure,
    ]);
    const listeners = await listenerPids(endpoint.port);
    const groups = await Promise.all(listeners.map(processGroupId));
    if (
      !childPid ||
      groups.length === 0 ||
      groups.some((group) => group !== childPid)
    ) {
      throw new PublicError(
        `ポート ${endpoint.port} の待受が起動したプロセスと一致しません`,
        409,
      );
    }
  } catch (error) {
    managedProcessGroups.delete(app.id);
    if (childPid) {
      try {
        process.kill(-childPid, "SIGTERM");
      } catch (killError) {
        if (errorCode(killError) !== "ESRCH") throw killError;
      }
    }
    throw error;
  } finally {
    startupController.abort();
  }
  return { message: `${app.name} を起動しました`, output: `ログ: ${logFile}` };
}

async function stopDetachedProcess(
  app: ManagedApp,
  endpoint: { address: string; port: number },
): Promise<ActionResult> {
  const lifecycle = app.lifecycle;
  if (!lifecycle || lifecycle.strategy !== "process") {
    throw new PublicError("このルートはprocess方式ではありません", 409);
  }

  let managedPid: number | null = managedProcessGroups.get(app.id) ?? null;
  if (managedPid) {
    try {
      await assertManagedPid(app, managedPid);
    } catch {
      managedProcessGroups.delete(app.id);
      managedPid = null;
    }
  }

  if (managedPid) {
    try {
      const current = await isPortOpen(endpoint.address, endpoint.port);
      process.kill(-managedPid, "SIGTERM");
      await Promise.all([
        waitForProcessGroupExit(managedPid, lifecycle.stopTimeoutMs),
        current.online
          ? waitForPort(
              endpoint.address,
              endpoint.port,
              false,
              lifecycle.stopTimeoutMs,
            )
          : Promise.resolve(),
      ]);
      managedProcessGroups.delete(app.id);
      return { message: `${app.name} を停止しました`, output: "" };
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error;
      managedProcessGroups.delete(app.id);
    }
  }

  const current = await isPortOpen(endpoint.address, endpoint.port);
  if (!current.online)
    return { message: `${app.name} はすでに停止しています`, output: "" };

  const pids = await listenerPids(endpoint.port);
  if (pids.length === 0) {
    throw new PublicError(
      `ポート ${endpoint.port} の PID を特定できませんでした`,
      409,
    );
  }
  const targets = await Promise.all(
    pids.map(async (pid) => {
      await assertManagedPid(app, pid);
      return { pid, processGroup: await managedProcessGroupId(app, pid) };
    }),
  );
  const processGroups = [
    ...new Set(
      targets
        .map((target) => target.processGroup)
        .filter(
          (processGroup): processGroup is number => processGroup !== null,
        ),
    ),
  ];
  const standalonePids = targets
    .filter((target) => target.processGroup === null)
    .map((target) => target.pid);

  for (const processGroup of processGroups)
    process.kill(-processGroup, "SIGTERM");
  for (const pid of standalonePids) process.kill(pid, "SIGTERM");
  await Promise.all([
    waitForPort(
      endpoint.address,
      endpoint.port,
      false,
      lifecycle.stopTimeoutMs,
    ),
    ...processGroups.map((processGroup) =>
      waitForProcessGroupExit(processGroup, lifecycle.stopTimeoutMs),
    ),
    ...standalonePids.map((pid) =>
      waitForProcessExit(pid, lifecycle.stopTimeoutMs),
    ),
  ]);
  return { message: `${app.name} を停止しました`, output: "" };
}

export async function executeAction(
  app: ManagedApp,
  action: ActionName,
  options: ExecuteActionOptions = {},
): Promise<ActionResult> {
  if (!app.configured || !app.lifecycle) {
    throw new PublicError(
      "このルートは監視のみで、操作は登録されていません",
      409,
    );
  }
  if (!["start", "restart", "stop"].includes(action)) {
    throw new PublicError("未対応の操作です");
  }

  const endpoint = parseUpstream(app.upstreams[0] ?? app.upstream);
  if (!endpoint) throw new PublicError("操作対象のポートを特定できません", 409);

  if (app.lifecycle.strategy === "commands") {
    if (action !== "stop")
      ensureRequiredEnvironment(app, {
        ...process.env,
        ...options.environment,
      });
    const command = app.lifecycle[action];
    if (!Array.isArray(command)) {
      throw new PublicError(`${action} コマンドが登録されていません`, 409);
    }
    const result = await runCommand(command, {
      cwd: app.directory,
      env: { ...process.env, ...options.environment },
      timeoutMs: app.lifecycle.timeoutMs,
    });
    const shouldBeOnline = action !== "stop";
    await waitForPort(endpoint.address, endpoint.port, shouldBeOnline, 5000);
    return {
      message: `${app.name} を${action === "stop" ? "停止" : action === "start" ? "起動" : "再起動"}しました`,
      output: result.output,
    };
  }

  if (action === "start") return startDetachedProcess(app, endpoint, options);
  if (action === "stop") return stopDetachedProcess(app, endpoint);
  await stopDetachedProcess(app, endpoint);
  return startDetachedProcess(app, endpoint, options);
}

function actionAvailability(
  app: ManagedApp,
  online: boolean,
): Record<ActionName, ActionAvailability> {
  const missingEnvironment = (app.requiredEnvironment ?? []).filter(
    (name) => !(app.options?.environment[name] ?? process.env[name]),
  );
  const hasControl = Boolean(app.configured && app.lifecycle);
  const hasStart = Boolean(app.lifecycle?.start);
  const hasRestart = Boolean(
    app.lifecycle?.strategy === "process" || app.lifecycle?.restart,
  );
  const hasStop = Boolean(
    app.lifecycle?.strategy === "process" || app.lifecycle?.stop,
  );
  const environmentReason = missingEnvironment.length
    ? `Localdeck の環境に ${missingEnvironment.join(", ")} がありません`
    : null;

  return {
    start: {
      enabled: hasControl && hasStart && !online && !environmentReason,
      reason: !hasControl
        ? "監視のみ"
        : !hasStart
          ? "起動コマンドがありません"
          : online
            ? "起動中です"
            : environmentReason,
    },
    restart: {
      enabled: hasControl && hasRestart && online && !environmentReason,
      reason: !hasControl
        ? "監視のみ"
        : !hasRestart
          ? "再起動コマンドがありません"
          : !online
            ? "停止中です"
            : environmentReason,
    },
    stop: {
      enabled: hasControl && hasStop && online,
      reason: !hasControl
        ? "監視のみ"
        : !hasStop
          ? "停止コマンドがありません"
          : !online
            ? "停止中です"
            : null,
    },
  };
}

function appDefinition(app: ManagedApp): AppDefinition {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    host: app.host,
    upstream: app.upstream,
    directory: app.directory,
    requiredEnvironment: app.requiredEnvironment ?? [],
    lifecycle: app.lifecycle,
    proxy: app.proxy ?? {},
    ...(app.options ? { options: app.options } : {}),
  };
}

export async function inspectApp(
  app: ManagedApp,
  options: InspectionOptions = {},
): Promise<InspectedApp> {
  const endpoint = parseUpstream(app.upstreams[0] ?? app.upstream);
  if (!endpoint) {
    return {
      ...app,
      url: `https://${app.host}`,
      directUrl: null,
      upstream: app.upstream,
      port: null,
      status: "unknown",
      latencyMs: null,
      pid: null,
      uptime: null,
      definition: appDefinition(app),
      actions: actionAvailability(app, false),
    };
  }

  const status = await isPortOpen(endpoint.address, endpoint.port);
  // Normal monitoring needs only TCP health. Expensive OS process queries are
  // explicitly requested by the details endpoint, never by the dashboard poll.
  const pids =
    status.online && options.includeProcessDetails === true
      ? await listenerPids(endpoint.port)
      : [];
  const pid = pids[0] ?? null;
  const uptime = pid ? await processUptime(pid) : null;
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    host: app.host,
    url: `https://${app.host}`,
    directUrl: `http://${endpoint.address}:${endpoint.port}`,
    upstream: `${endpoint.address}:${endpoint.port}`,
    upstreams: app.upstreams,
    port: endpoint.port,
    status: status.online ? "online" : "offline",
    latencyMs: status.latencyMs,
    pid,
    uptime,
    directory: app.directory,
    configured: app.configured,
    caddyRouteFound: app.caddyRouteFound,
    definition: appDefinition(app),
    actions: actionAvailability(app, status.online),
  };
}
