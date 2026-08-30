import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherFile = path.join(projectRoot, "bin", "localdeck");

function functionDefinitions(source) {
  const dispatchMarker = "\ncommand=${1:-start}\n";
  const dispatchIndex = source.indexOf(dispatchMarker);
  assert.notEqual(dispatchIndex, -1);
  return source.slice(0, dispatchIndex);
}

test("localdeck launcher のシェル構文を検証する", async () => {
  await execFileAsync("/bin/sh", ["-n", launcherFile]);
});

test("launchd Caddy の restart は登録解除せず kickstart する", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "localdeck-launcher-test-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const source = await readFile(launcherFile, "utf8");
  const launchctlLog = path.join(temporaryDirectory, "launchctl.log");
  const launchctlStub = path.join(temporaryDirectory, "launchctl");
  const harnessFile = path.join(temporaryDirectory, "restart-caddy.sh");

  await writeFile(
    launchctlStub,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$LOCALDECK_LAUNCHCTL_LOG\"\n",
  );
  await chmod(launchctlStub, 0o755);
  await writeFile(
    harnessFile,
    `${functionDefinitions(source)}
install_caddy_service() { return 0; }
caddy_service_loaded() { return 0; }
inspect_managed_pid() { managed_pid=123; return 0; }
wait_until_ready() { managed_pid=456; return 0; }
caddy_service_target=gui/501/com.example.caddy
caddy_log_file=/tmp/caddy.log
restart_caddy
`,
  );

  const { stdout } = await execFileAsync("/bin/sh", [harnessFile], {
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
      LOCALDECK_LAUNCHCTL_LOG: launchctlLog,
    },
  });

  assert.match(stdout, /Caddy restarted by launchd \(PID 456\)/);
  assert.equal(
    (await readFile(launchctlLog, "utf8")).trim(),
    "kickstart -k gui/501/com.example.caddy",
  );
});

test("restart は dashboard 停止後に Caddy を直接再起動する", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "localdeck-restart-test-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const source = await readFile(launcherFile, "utf8");
  const harnessFile = path.join(temporaryDirectory, "restart-all.sh");
  await writeFile(
    harnessFile,
    `${functionDefinitions(source)}
raise_open_file_limit() { echo raise-limit; }
stop_dashboard() { echo stop-dashboard; }
restart_caddy() { echo restart-caddy; }
start_dashboard() { echo start-dashboard; }
sync_routes() { echo sync-routes; }
restart_all
`,
  );

  const { stdout } = await execFileAsync("/bin/sh", [harnessFile]);
  assert.deepEqual(stdout.trim().split("\n"), [
    "raise-limit",
    "stop-dashboard",
    "restart-caddy",
    "start-dashboard",
    "sync-routes",
    "https://apps.localhost",
  ]);
  assert.match(source, /\n[ ]{2}restart\)\n[ ]{4}restart_all\n[ ]{4};;/);
});
