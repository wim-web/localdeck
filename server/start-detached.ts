import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";

async function startDetached(
  entrypoint: string,
  workingDirectory: string,
  logFile: string,
): Promise<number> {
  const logHandle = await open(path.resolve(logFile), "a");

  try {
    const child = spawn(process.execPath, [path.resolve(entrypoint)], {
      cwd: path.resolve(workingDirectory),
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 1) {
      throw new Error("Detached process PID could not be determined");
    }
    child.unref();
    return child.pid!;
  } finally {
    await logHandle.close();
  }
}

const [entrypoint, workingDirectory, logFile] = process.argv.slice(2);

if (!entrypoint || !workingDirectory || !logFile) {
  console.error("Usage: node dist-server/start-detached.js <entrypoint> <cwd> <log-file>");
  process.exitCode = 2;
} else {
  const childPid = await startDetached(entrypoint, workingDirectory, logFile);
  process.stdout.write(`${childPid}\n`);
}
