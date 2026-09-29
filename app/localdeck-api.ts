import type {
  ActionName,
  ActionResponse,
  AppDefinition,
  Snapshot,
} from "./localdeck-types";

const ACTION_HEADERS = { "X-Localdeck-Action": "1" } as const;

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  if (!response.ok) {
    const message =
      (body as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const response = await fetch("/api/apps", { cache: "no-store" });
  return readJson<Snapshot>(response);
}

export async function runAppAction(
  appId: string,
  action: ActionName,
): Promise<ActionResponse> {
  const response = await fetch(`/api/apps/${appId}/${action}`, {
    method: "POST",
    headers: ACTION_HEADERS,
  });
  return readJson<ActionResponse>(response);
}

export async function saveAppDefinition(
  definition: AppDefinition,
  editing: boolean,
): Promise<ActionResponse> {
  const response = await fetch(
    editing ? `/api/apps/${definition.id}` : "/api/apps",
    {
      method: editing ? "PUT" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...ACTION_HEADERS,
      },
      body: JSON.stringify(definition),
    },
  );
  return readJson<ActionResponse>(response);
}

export async function deleteAppDefinition(
  appId: string,
): Promise<ActionResponse> {
  const response = await fetch(`/api/apps/${appId}`, {
    method: "DELETE",
    headers: ACTION_HEADERS,
  });
  return readJson<ActionResponse>(response);
}

export async function syncCaddyRoutes(): Promise<ActionResponse> {
  const response = await fetch("/api/caddy/sync", {
    method: "POST",
    headers: ACTION_HEADERS,
  });
  return readJson<ActionResponse>(response);
}

export async function mutateDashboard(
  path: string,
  body: unknown,
  method = "POST",
): Promise<ActionResponse> {
  return readJson<ActionResponse>(
    await fetch(path, {
      method,
      headers: { ...ACTION_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
export async function fetchLogs(
  appId: string,
  source: string,
  signal?: AbortSignal,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  return readJson(
    await fetch(
      `/api/apps/${appId}/logs?source=${encodeURIComponent(source)}`,
      { signal },
    ),
  );
}
