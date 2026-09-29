export type ActionName = "start" | "restart" | "stop";

export type CommandLifecycle = {
  strategy: "commands";
  start: string[] | null;
  restart: string[] | null;
  stop: string[] | null;
  timeoutMs: number;
};

export type ProcessLifecycle = {
  strategy: "process";
  start: string[];
  startTimeoutMs: number;
  stopTimeoutMs: number;
};

export type LifecycleDefinition = CommandLifecycle | ProcessLifecycle | null;

export type PortSettings = { mode: "fixed" | "auto"; environment: string };
export type BackendDefinition = {
  id: string;
  name: string;
  directory: string;
  start: string[];
  port: number;
  portSettings: PortSettings;
  environment: Record<string, string>;
};
export type AppOptions = {
  categoryId: string | null;
  port: PortSettings;
  environment: Record<string, string>;
  backends: BackendDefinition[];
  wakeOnRequest: boolean;
  idleStopMinutes: number;
  activityPath: string;
  requestOnlyIdle: boolean;
  keepAlive: boolean;
};
export type Category = { id: string; name: string; color: string };
export type AppRuntime = {
  phase: "starting" | "stopping" | "running" | "stopped" | "error";
  lastError: string | null;
  changedAt: string;
};
export type ProcessView = {
  id: string;
  name: string;
  port: number;
  online: boolean;
  pid: number | null;
};

export type AppDefinition = {
  id: string;
  name: string;
  description: string;
  host: string;
  upstream: string;
  directory: string | null;
  requiredEnvironment: string[];
  lifecycle: LifecycleDefinition;
  proxy: { headerUpHost?: string };
  options?: AppOptions;
};

export type DashboardConfig = {
  name: string;
  host: string;
  bind: string;
  port: number;
};

export type LocaldeckConfig = {
  version: 1;
  caddyAdminUrl: string;
  dashboard: DashboardConfig;
  apps: AppDefinition[];
  categories?: Category[];
};

export type LegacyConfig = {
  version: 1;
  caddyAdminUrl?: string;
  dashboard: {
    name?: string;
    host: string;
    bind?: string;
    port: number;
  };
  apps?: unknown[];
};

export type CaddyRoute = {
  host: string;
  server: string;
  upstreams: string[];
};

export type CaddyState = {
  connected: boolean;
  routes: CaddyRoute[];
  latencyMs: number | null;
  error: string | null;
};

export type ManagedApp = AppDefinition & {
  configured: true;
  caddyRouteFound: boolean;
  upstreams: string[];
};

export type ActionAvailability = {
  enabled: boolean;
  reason: string | null;
};

export type InspectedApp = {
  id: string;
  name: string;
  description: string;
  host: string;
  url: string;
  directUrl: string | null;
  upstream: string | null;
  upstreams: string[];
  port: number | null;
  status: "online" | "offline" | "unknown";
  latencyMs: number | null;
  pid: number | null;
  uptime: string | null;
  directory: string | null;
  configured: boolean;
  caddyRouteFound: boolean;
  definition: AppDefinition;
  actions: Record<ActionName, ActionAvailability>;
  runtime?: AppRuntime & {
    processes: ProcessView[];
    idleUntil: string | null;
    activeRequests: number;
    idleReason: string | null;
  };
};

export type Snapshot = {
  generatedAt: string;
  caddy: {
    connected: boolean;
    routeCount: number;
    expectedRouteCount: number;
    totalRouteCount: number;
    inSync: boolean;
    latencyMs: number | null;
    error: string | null;
  };
  summary: {
    total: number;
    online: number;
    offline: number;
  };
  apps: InspectedApp[];
  categories?: Category[];
};

export type ActionResponse = {
  ok: true;
  message: string;
  output?: string;
  warning?: string | null;
  snapshot: Snapshot;
};

export interface LocaldeckStoreLike {
  getConfig(): LocaldeckConfig;
  listApps(): AppDefinition[];
  getApp(id: string): AppDefinition | null;
  createApp(input: unknown): AppDefinition;
  updateApp(id: string, input: unknown): AppDefinition | null;
  deleteApp(id: string): AppDefinition | null;
  reorderApps?(ids: string[]): void;
  listCategories?(): Category[];
  saveCategory?(category: Category): Category;
  deleteCategory?(id: string): void;
  getRuntime?(id: string): AppRuntime | null;
  setRuntime?(id: string, runtime: AppRuntime): void;
  close(): void;
}

export type ActionResult = {
  warning?: string | null;
  message: string;
  output: string;
};
