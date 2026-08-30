import type { InspectedApp, Snapshot as ServerSnapshot } from "../server/types";

export type {
  ActionResponse,
  ActionAvailability,
  ActionName,
  AppDefinition,
  LifecycleDefinition,
} from "../server/types";

export type LocalApp = InspectedApp;
export type Snapshot = ServerSnapshot;

export type FormState = {
  id: string;
  name: string;
  description: string;
  host: string;
  upstream: string;
  directory: string;
  requiredEnvironment: string;
  strategy: "none" | "commands" | "process";
  startCommand: string;
  restartCommand: string;
  stopCommand: string;
  timeoutMs: string;
  startTimeoutMs: string;
  stopTimeoutMs: string;
  headerUpHost: string;
};

export type Notice = {
  tone: "warning" | "error";
  text: string;
};

export type CommandItem = {
  id: string;
  label: string;
  keywords: string;
  disabled?: boolean;
  reason?: string | null;
  tone?: "default" | "danger";
  run: () => void;
};
