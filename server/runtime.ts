import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";

import { errorCode, errorMessage } from "./errors.js";
import type { LocaldeckApplication } from "./http.js";
import type { LocaldeckConfig, LocaldeckStoreLike } from "./types.js";

type RuntimeLogger = Pick<Console, "log" | "error">;
type RuntimeSignal = "SIGINT" | "SIGTERM";
type RuntimeSignalSource = {
  once(signal: RuntimeSignal, listener: () => void): unknown;
  off(signal: RuntimeSignal, listener: () => void): unknown;
};

export type LocaldeckRuntimeOptions = {
  server: Server;
  application: LocaldeckApplication;
  store: LocaldeckStoreLike;
  config: LocaldeckConfig;
  pidFile: string;
  reconcileIntervalMs?: number;
  logger?: RuntimeLogger;
  signalSource?: RuntimeSignalSource;
  writePid?: (pidFile: string) => Promise<void>;
};

async function recordPid(pidFile: string): Promise<void> {
  await mkdir(path.dirname(pidFile), { recursive: true });
  const temporary = `${pidFile}.tmp.${process.pid}`;
  await writeFile(temporary, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, pidFile);
}

async function clearOwnPid(pidFile: string, logger: RuntimeLogger): Promise<void> {
  try {
    const recorded = (await readFile(pidFile, "utf8")).trim();
    if (recorded === String(process.pid)) await unlink(pidFile);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") logger.error(error);
  }
}

function listen(server: Server, config: LocaldeckConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.dashboard.port, config.dashboard.bind);
  });
}

function closeServer(server: Server): Promise<Error | undefined> {
  return new Promise((resolve) => {
    server.close((error) => resolve(error));
  });
}

export async function startLocaldeckRuntime(
  options: LocaldeckRuntimeOptions,
): Promise<{ shutdown(signal: string): Promise<void> }> {
  const {
    server,
    application,
    store,
    config,
    pidFile,
    reconcileIntervalMs = 15_000,
    logger = console,
    signalSource = process,
    writePid = recordPid,
  } = options;
  let reconcileTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  let pidInitialization: Promise<void> = Promise.resolve();
  let shutdownPromise: Promise<void> | null = null;

  const removeSignalListeners = (): void => {
    signalSource.off("SIGINT", onSigint);
    signalSource.off("SIGTERM", onSigterm);
  };

  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    if (reconcileTimer) clearInterval(reconcileTimer);
    logger.log(`${signal}: shutting down`);
    shutdownPromise = (async () => {
      try {
        await pidInitialization;
        const closeError = await closeServer(server);
        await clearOwnPid(pidFile, logger);
        store.close();
        if (closeError) {
          logger.error(closeError);
          process.exitCode = 1;
        }
      } finally {
        removeSignalListeners();
      }
    })();
    return shutdownPromise;
  };

  function onSigint(): void {
    void shutdown("SIGINT");
  }

  function onSigterm(): void {
    void shutdown("SIGTERM");
  }

  await listen(server, config);
  signalSource.once("SIGINT", onSigint);
  signalSource.once("SIGTERM", onSigterm);
  pidInitialization = writePid(pidFile).catch((error: unknown) => {
    logger.error("PID file could not be written", error);
  });
  await pidInitialization;
  if (shuttingDown) {
    await shutdownPromise;
    return { shutdown };
  }
  logger.log(
    `${config.dashboard.name} listening on http://${config.dashboard.bind}:${config.dashboard.port}`,
  );
  try {
    await application.synchronizeCaddy();
    logger.log("Caddy configuration synchronized from SQLite");
  } catch (error) {
    logger.error(`Caddy synchronization deferred: ${errorMessage(error, "unknown error")}`);
  }
  if (shuttingDown) {
    await shutdownPromise;
    return { shutdown };
  }

  reconcileTimer = setInterval(() => {
    void application.reconcileCaddyIfNeeded().catch((error) =>
      logger.error(`Caddy reconciliation failed: ${errorMessage(error, "unknown error")}`),
    );
  }, reconcileIntervalMs);
  reconcileTimer.unref();
  return { shutdown };
}
