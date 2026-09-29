import { open, realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import type { AppDefinition } from "./types.js";
import { PublicError } from "./errors.js";

export async function readAppLogs(
  app: AppDefinition,
  directory: string,
  source = "main",
) {
  if (
    source !== "main" &&
    !app.options?.backends.some((backend) => backend.id === source)
  )
    throw new PublicError("ログが見つかりません", 404);
  const name = source === "main" ? app.id : `${app.id}__${source}`;
  const filename = path.join(directory, `${name}.log`);
  let handle;
  try {
    handle = await open(filename, "r");
    const info = await handle.stat();
    const length = Math.min(info.size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      info.size - length,
    );
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (info.size > length) text = text.slice(text.indexOf("\n") + 1);
    return { text, bytes: info.size, truncated: info.size > length };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { text: "", bytes: 0, truncated: false };
    throw error;
  } finally {
    await handle?.close();
  }
}

const iconCandidates = [
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/appicon.png",
  "web/public/favicon.svg",
  "web/public/favicon.ico",
  "web/public/favicon.png",
  "apps/web/public/favicon.svg",
  "apps/web/public/favicon.ico",
  "apps/web/public/favicon.png",
  "local/favicon.svg",
  "favicon.ico",
];
export async function readAppIcon(
  app: AppDefinition,
): Promise<{ body: Buffer; type: string } | null> {
  if (!app.directory) return null;
  let root: string;
  try {
    root = await realpath(app.directory);
  } catch {
    return null;
  }
  for (const candidate of iconCandidates) {
    try {
      const filename = await realpath(path.join(root, candidate));
      if (!filename.startsWith(`${root}${path.sep}`)) continue;
      const info = await stat(filename);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      const body = await readFile(filename);
      const extension = path.extname(filename);
      return {
        body,
        type:
          extension === ".svg"
            ? "image/svg+xml"
            : extension === ".png"
              ? "image/png"
              : "image/x-icon",
      };
    } catch {
      /* Try the next conventional icon location. */
    }
  }
  return null;
}
