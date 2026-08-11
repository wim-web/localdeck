import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";

const [entrypoint, workingDirectory, logFile] = process.argv.slice(2);

if (!entrypoint || !workingDirectory || !logFile) {
  console.error("Usage: node server/start-detached.mjs <entrypoint> <cwd> <log-file>");
  process.exitCode = 2;
} else {
  const logHandle = await open(path.resolve(logFile), "a");
  let child;

  try {
    child = spawn(process.execPath, [path.resolve(entrypoint)], {
      cwd: path.resolve(workingDirectory),
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    await logHandle.close();
  }

  child.unref();
  process.stdout.write(`${child.pid}\n`);
}
