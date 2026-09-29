import net from "node:net";
import http from "node:http";
import { DEFAULT_OPTIONS, parseUpstream } from "./config.js";
import { PublicError, errorMessage } from "./errors.js";
import type {
  ActionName,
  ActionResult,
  AppDefinition,
  AppRuntime,
  BackendDefinition,
  InspectedApp,
  LocaldeckStoreLike,
  ManagedApp,
} from "./types.js";

export type Execute = (
  app: ManagedApp,
  action: ActionName,
  options: { appLogDirectory: string; environment?: NodeJS.ProcessEnv },
) => Promise<ActionResult>;
export type Inspect = (app: ManagedApp) => Promise<InspectedApp>;
export function managed(app: AppDefinition): ManagedApp {
  return {
    ...app,
    configured: true,
    caddyRouteFound: true,
    upstreams: [app.upstream],
  };
}
export function usesGateway(app: AppDefinition): boolean {
  return Boolean(app.options?.wakeOnRequest || app.options?.idleStopMinutes);
}
export function backendApp(
  app: AppDefinition,
  backend: BackendDefinition,
): ManagedApp {
  const lifecycle =
    app.lifecycle?.strategy === "process" ? app.lifecycle : null;
  return managed({
    ...app,
    id: `${app.id}__${backend.id}`,
    name: backend.name,
    upstream: `127.0.0.1:${backend.port}`,
    directory: backend.directory,
    options: undefined,
    requiredEnvironment: [],
    lifecycle: lifecycle ? { ...lifecycle, start: backend.start } : null,
  });
}

type Reservation = { port: number; release(): Promise<void> };
async function bindPort(port: number, host: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { port, host, exclusive: true, ipv6Only: host === "::1" },
      () => {
        server.off("error", reject);
        resolve();
      },
    );
  });
  return server;
}
async function reserve(
  port: number,
  automatic: boolean,
  excluded: Set<number>,
): Promise<Reservation> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const requested = attempt === 0 && !excluded.has(port) ? port : 0;
    if (!automatic && (excluded.has(port) || attempt > 0))
      throw new PublicError(`ポート ${port} は使用中です`, 409);
    const servers: net.Server[] = [];
    try {
      const ipv4 = await bindPort(requested, "127.0.0.1");
      servers.push(ipv4);
      const assigned = (ipv4.address() as net.AddressInfo).port;
      if (excluded.has(assigned)) throw new Error("reserved port");
      try {
        servers.push(await bindPort(assigned, "::1"));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(String(error.code))
          )
        )
          throw error;
      }
      return {
        port: assigned,
        release: async () => {
          await Promise.all(
            servers.map(
              (s) => new Promise<void>((done) => s.close(() => done())),
            ),
          );
        },
      };
    } catch {
      await Promise.all(
        servers.map((s) => new Promise<void>((done) => s.close(() => done()))),
      );
    }
  }
  throw new PublicError("空きポートを確保できませんでした", 409);
}

export function expandPorts(
  value: string,
  main: number,
  backends: BackendDefinition[],
): string {
  return value
    .replaceAll("{port}", String(main))
    .replace(/\{backendPort:([^}]+)\}/g, (_match, id: string) => {
      const backend = backends.find((b) => b.id === id);
      if (!backend)
        throw new PublicError(`バックエンド ${id} が見つかりません`);
      return String(backend.port);
    });
}

export class AppSupervisor {
  private operations = new Map<string, Promise<ActionResult>>();
  private states = new Map<string, AppRuntime>();
  private activity = new Map<
    string,
    { last: number; active: number; reason: string | null }
  >();
  private maintaining: Promise<void> | null = null;
  private closing = false;
  private configurationLocks = new Set<string>();
  constructor(
    private dependencies: {
      store: LocaldeckStoreLike;
      inspect: Inspect;
      execute: Execute;
      appLogDirectory: string;
      synchronize: () => Promise<void>;
      now: () => Date;
    },
  ) {}

  busy(id: string): boolean {
    return this.operations.has(id) || this.configurationLocks.has(id);
  }
  lockConfiguration(id: string): () => void {
    if (this.busy(id) || this.closing)
      throw new PublicError("このアプリは別の操作を実行中です", 409);
    this.configurationLocks.add(id);
    return () => this.configurationLocks.delete(id);
  }
  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([
      ...this.operations.values(),
      ...(this.maintaining ? [this.maintaining] : []),
    ]);
  }
  private getActivity(id: string) {
    let value = this.activity.get(id);
    if (!value) {
      value = {
        last: this.dependencies.now().getTime(),
        active: 0,
        reason: null,
      };
      this.activity.set(id, value);
    }
    return value;
  }
  beginRequest(id: string): () => void {
    const activity = this.getActivity(id);
    activity.active++;
    activity.last = this.dependencies.now().getTime();
    let ended = false;
    return () => {
      if (!ended) {
        ended = true;
        activity.active--;
        activity.last = this.dependencies.now().getTime();
      }
    };
  }
  touch(id: string): void {
    const activity = this.getActivity(id);
    activity.last = this.dependencies.now().getTime();
    activity.reason = null;
  }
  private state(id: string): AppRuntime | null {
    return (
      this.states.get(id) ?? this.dependencies.store.getRuntime?.(id) ?? null
    );
  }
  private setState(
    id: string,
    phase: AppRuntime["phase"],
    lastError: string | null = null,
  ): void {
    const state = {
      phase,
      lastError,
      changedAt: this.dependencies.now().toISOString(),
    };
    this.states.set(id, state);
    this.dependencies.store.setRuntime?.(id, state);
  }
  async inspect(app: ManagedApp): Promise<InspectedApp> {
    const main = await this.dependencies.inspect(app);
    const children = await Promise.all(
      (app.options?.backends ?? []).map(async (backend) => ({
        backend,
        view: await this.dependencies.inspect(backendApp(app, backend)),
      })),
    );
    const processes = [
      {
        id: "main",
        name: "メイン",
        port: main.port ?? 0,
        online: main.status === "online",
        pid: main.pid,
      },
      ...children.map(({ backend, view }) => ({
        id: backend.id,
        name: backend.name,
        port: backend.port,
        online: view.status === "online",
        pid: view.pid,
      })),
    ];
    let state = this.state(app.id);
    if (
      !this.busy(app.id) &&
      state &&
      (state.phase === "starting" || state.phase === "stopping")
    ) {
      this.setState(
        app.id,
        "error",
        "前回の操作中にLocaldeckが終了しました。プロセス状態を確認してください。",
      );
      state = this.state(app.id);
    } else if (
      !this.busy(app.id) &&
      state?.phase === "running" &&
      processes.some((p) => !p.online)
    ) {
      this.setState(
        app.id,
        "error",
        "プロセスの停止を検出しました。ログを確認してください。",
      );
      state = this.state(app.id);
    }
    const activity = this.getActivity(app.id);
    const options = app.options ?? DEFAULT_OPTIONS;
    const phase =
      state?.phase === "error" || this.busy(app.id)
        ? (state?.phase ?? "starting")
        : main.status === "online"
          ? "running"
          : "stopped";
    const actions = { ...main.actions };
    if (this.busy(app.id))
      for (const action of ["start", "restart", "stop"] as const)
        actions[action] = { enabled: false, reason: "操作中です" };
    else if (
      children.some(({ view }) => view.status === "online") &&
      app.lifecycle?.strategy === "process"
    ) {
      actions.stop = { enabled: true, reason: null };
      actions.restart = { enabled: true, reason: null };
      actions.start = {
        enabled: false,
        reason: "バックエンドが稼働しています。再起動してください",
      };
    }
    return {
      ...main,
      definition: {
        ...app,
        ...main.definition,
        ...(app.options ? { options: app.options } : {}),
      },
      actions,
      runtime: {
        phase,
        lastError: state?.lastError ?? null,
        changedAt: state?.changedAt ?? this.dependencies.now().toISOString(),
        processes,
        activeRequests: activity.active,
        idleReason: activity.reason,
        idleUntil:
          options.idleStopMinutes &&
          !options.keepAlive &&
          main.status === "online" &&
          activity.active === 0
            ? new Date(
                activity.last + options.idleStopMinutes * 60_000,
              ).toISOString()
            : null,
      },
    };
  }
  async wake(id: string): Promise<void> {
    const ongoing = this.operations.get(id);
    if (ongoing) {
      await ongoing;
    }
    const app = this.dependencies.store.getApp(id);
    if (!app) throw new PublicError("アプリが見つかりません", 404);
    const view = await this.dependencies.inspect(managed(app));
    if (view.status === "online") return;
    if (!app.options?.wakeOnRequest)
      throw new PublicError(
        "アプリは停止中です。Localdeckから起動してください",
        503,
      );
    await this.run(id, "start", true);
  }
  run(id: string, action: ActionName, join = false): Promise<ActionResult> {
    if (this.closing || this.configurationLocks.has(id))
      return Promise.reject(
        new PublicError("このアプリは別の操作を実行中です", 409),
      );
    const ongoing = this.operations.get(id);
    if (ongoing)
      return join
        ? ongoing
        : Promise.reject(
            new PublicError("このアプリは別の操作を実行中です", 409),
          );
    const task = this.perform(id, action)
      .then(async (result) => {
        try {
          await this.dependencies.synchronize();
          return result;
        } catch (error) {
          return {
            ...result,
            warning: errorMessage(error, "ルート更新に失敗しました"),
          };
        }
      })
      .finally(() => this.operations.delete(id));
    this.operations.set(id, task);
    return task;
  }
  private async perform(id: string, action: ActionName): Promise<ActionResult> {
    const { store, execute, inspect, appLogDirectory } = this.dependencies;
    let app = store.getApp(id);
    if (!app) throw new PublicError("アプリが見つかりません", 404);
    this.setState(id, action === "stop" ? "stopping" : "starting");
    const reservations: Reservation[] = [];
    const started: ManagedApp[] = [];
    try {
      // Legacy command lifecycles retain their existing start/restart/stop semantics.
      if (!app.options || app.lifecycle?.strategy !== "process") {
        const target = managed(app);
        let environment = app.options?.environment;
        if (app.options && app.lifecycle?.strategy === "commands") {
          const port = parseUpstream(app.upstream)!.port;
          const expand = (value: string) => expandPorts(value, port, []);
          target.lifecycle = {
            ...app.lifecycle,
            start: app.lifecycle.start?.map(expand) ?? null,
            restart: app.lifecycle.restart?.map(expand) ?? null,
            stop: app.lifecycle.stop?.map(expand) ?? null,
          };
          environment = Object.fromEntries(
            Object.entries(app.options.environment).map(([key, value]) => [
              key,
              expand(value),
            ]),
          );
          if (app.options.port.environment)
            environment[app.options.port.environment] = String(port);
        }
        const result = await execute(target, action, {
          appLogDirectory,
          environment,
        });
        this.setState(id, action === "stop" ? "stopped" : "running");
        this.touch(id);
        return result;
      }
      if (action !== "start") {
        const errors: string[] = [];
        const targets = [
          managed(app),
          ...app.options.backends
            .slice()
            .reverse()
            .map((b) => backendApp(app!, b)),
        ];
        for (const target of targets) {
          try {
            await execute(target, "stop", { appLogDirectory });
          } catch (error) {
            errors.push(errorMessage(error, "停止に失敗しました"));
          }
        }
        if (errors.length) throw new PublicError(errors.join(" / "), 500);
        if (action === "stop") {
          this.setState(id, "stopped");
          return { message: `${app.name} を停止しました`, output: "" };
        }
      }
      const previousTargets = [
        managed(app),
        ...app.options.backends.map((b) => backendApp(app!, b)),
      ];
      for (const target of previousTargets)
        if ((await inspect(target)).status === "online")
          throw new PublicError(`${target.name} はすでに起動しています`, 409);
      const endpoint = parseUpstream(app.upstream)!;
      const mainLease = await reserve(
        endpoint.port,
        app.options.port.mode === "auto",
        new Set(),
      );
      reservations.push(mainLease);
      const excluded = new Set([mainLease.port]);
      const backends: BackendDefinition[] = [];
      for (const backend of app.options.backends) {
        const lease = await reserve(
          backend.port,
          backend.portSettings.mode === "auto",
          excluded,
        );
        reservations.push(lease);
        excluded.add(lease.port);
        backends.push({ ...backend, port: lease.port });
      }
      const address = endpoint.address.includes(":")
        ? `[${endpoint.address}]`
        : endpoint.address;
      const updated = store.updateApp(id, {
        upstream: `${address}:${mainLease.port}`,
        options: { ...app.options, backends },
      });
      if (!updated) throw new PublicError("アプリが削除されました", 409);
      app = updated;
      const mainPort = mainLease.port;
      const expand = (text: string) => expandPorts(text, mainPort, backends);
      const makeEnvironment = (
        values: Record<string, string>,
        key: string,
        port: number,
      ) => ({
        ...Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, expand(value)]),
        ),
        ...(key ? { [key]: String(port) } : {}),
      });
      for (let index = 0; index < backends.length; index++) {
        const backend = backends[index];
        const target = backendApp(app, {
          ...backend,
          start: backend.start.map(expand),
        });
        await reservations[index + 1].release();
        await execute(target, "start", {
          appLogDirectory,
          environment: makeEnvironment(
            { ...app.options!.environment, ...backend.environment },
            backend.portSettings.environment,
            backend.port,
          ),
        });
        started.push(target);
      }
      const target = managed({
        ...app,
        lifecycle: {
          ...app.lifecycle!,
          strategy: "process",
          start: app.lifecycle!.start!.map(expand),
        } as AppDefinition["lifecycle"],
      });
      await mainLease.release();
      const result = await execute(target, "start", {
        appLogDirectory,
        environment: makeEnvironment(
          app.options!.environment,
          app.options!.port.environment,
          mainPort,
        ),
      });
      started.push(target);
      this.setState(id, "running");
      this.touch(id);
      return result;
    } catch (error) {
      const cleanupErrors: string[] = [];
      for (const target of started.reverse()) {
        try {
          await execute(target, "stop", { appLogDirectory });
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError, "停止に失敗しました"));
        }
      }
      const message =
        errorMessage(error, "操作に失敗しました") +
        (cleanupErrors.length
          ? ` / 起動済みプロセスの停止: ${cleanupErrors.join(" / ")}`
          : "");
      this.setState(id, "error", message);
      throw new PublicError(
        message,
        error instanceof PublicError ? error.status : 500,
      );
    } finally {
      await Promise.all(reservations.map((lease) => lease.release()));
    }
  }
  maintain(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.maintaining) return this.maintaining;
    this.maintaining = this.performMaintenance().finally(() => {
      this.maintaining = null;
    });
    return this.maintaining;
  }
  private async performMaintenance(): Promise<void> {
    for (const app of this.dependencies.store.listApps()) {
      if (this.closing) return;
      const options = app.options;
      if (!options?.idleStopMinutes || options.keepAlive || this.busy(app.id))
        continue;
      const activity = this.getActivity(app.id);
      if (
        activity.active ||
        this.dependencies.now().getTime() - activity.last <
          options.idleStopMinutes * 60_000
      )
        continue;
      if ((await this.inspect(managed(app))).runtime?.phase !== "running")
        continue;
      let mayStop = options.requestOnlyIdle;
      if (options.activityPath) {
        try {
          const body = await new Promise<{ busy?: unknown }>(
            (resolve, reject) => {
              const endpoint = parseUpstream(app.upstream)!;
              const request = http.get(
                {
                  hostname: endpoint.address,
                  port: endpoint.port,
                  path: options.activityPath,
                  headers: { Host: app.proxy.headerUpHost ?? app.host },
                  signal: AbortSignal.timeout(1500),
                },
                (response) => {
                  let text = "";
                  response.setEncoding("utf8");
                  response.on("data", (chunk: string) => {
                    text += chunk;
                    if (text.length > 64_000)
                      request.destroy(new Error("response too large"));
                  });
                  response.on("error", reject);
                  response.on("end", () => {
                    try {
                      if (response.statusCode !== 200)
                        throw new Error(`HTTP ${response.statusCode}`);
                      const result: unknown = JSON.parse(text);
                      if (!result || typeof result !== "object")
                        throw new Error("invalid activity response");
                      resolve(result);
                    } catch (error) {
                      reject(error);
                    }
                  });
                },
              );
              request.on("error", reject);
            },
          );
          mayStop = body.busy === false;
          activity.reason = mayStop
            ? null
            : "バックグラウンド処理中、または処理状態を確認できません";
        } catch {
          mayStop = false;
          activity.reason = "処理状態を確認できないため起動を維持しています";
        }
      }
      // Requests or a keep-alive update may arrive while the activity endpoint is checked.
      const current = this.dependencies.store.getApp(app.id);
      if (
        this.closing ||
        !mayStop ||
        current?.options?.keepAlive ||
        !current?.options?.idleStopMinutes ||
        activity.active ||
        this.busy(app.id) ||
        this.dependencies.now().getTime() - activity.last <
          current.options.idleStopMinutes * 60_000
      )
        continue;
      try {
        await this.run(app.id, "stop");
      } catch (error) {
        activity.reason = errorMessage(error, "自動停止に失敗しました");
      }
    }
  }
}
