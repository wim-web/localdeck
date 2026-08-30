import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fetchCaddyState, syncCaddyConfig } from "./caddy.js";
import { openLocaldeckStore } from "./database.js";
import { errorMessage } from "./errors.js";
import { createLocaldeckServer } from "./http.js";
import { executeAction, inspectApp } from "./process-manager.js";
import { startLocaldeckRuntime } from "./runtime.js";

export type LocaldeckPaths = {
  projectRoot: string;
  staticRoot: string;
  pidFile: string;
  appLogDirectory: string;
  legacyConfigPath: string;
  databasePath: string;
};

export function resolveLocaldeckPaths(
  environment: NodeJS.ProcessEnv = process.env,
): LocaldeckPaths {
  const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(serverDirectory, "..");
  return {
    projectRoot,
    staticRoot: path.join(projectRoot, "dist-local"),
    pidFile: path.join(projectRoot, "state", "localdeck.pid"),
    appLogDirectory: path.join(projectRoot, "logs", "apps"),
    legacyConfigPath: environment.LOCALDECK_CONFIG
      ? path.resolve(environment.LOCALDECK_CONFIG)
      : path.join(projectRoot, "apps.config.json"),
    databasePath: environment.LOCALDECK_DATABASE
      ? path.resolve(environment.LOCALDECK_DATABASE)
      : path.join(projectRoot, "state", "localdeck.sqlite"),
  };
}

export async function startLocaldeck(
  paths: LocaldeckPaths = resolveLocaldeckPaths(),
): Promise<void> {
  const store = await openLocaldeckStore({
    databasePath: paths.databasePath,
    legacyConfigPath: paths.legacyConfigPath,
  });
  try {
    const config = store.getConfig();
    const application = createLocaldeckServer({
      store,
      staticRoot: paths.staticRoot,
      appLogDirectory: paths.appLogDirectory,
      fetchCaddyState,
      syncCaddyConfig,
      inspectApp,
      executeAction,
    });
    await startLocaldeckRuntime({
      server: application.server,
      application,
      store,
      config,
      pidFile: paths.pidFile,
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href,
  );
}

if (isMainModule()) {
  void startLocaldeck().catch((error) => {
    console.error(errorMessage(error, "Localdeckを起動できませんでした"));
    process.exitCode = 1;
  });
}
