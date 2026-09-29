import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { parseUpstream } from "./config.js";
import { PublicError, errorMessage } from "./errors.js";
import { usesGateway } from "./supervisor.js";
import type { AppSupervisor } from "./supervisor.js";
import type { AppDefinition, LocaldeckStoreLike } from "./types.js";

function requestHostname(request: IncomingMessage): string {
  try {
    return new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    return "";
  }
}
export function gatewayApp(
  request: IncomingMessage,
  store: LocaldeckStoreLike,
): AppDefinition | undefined {
  return store.listApps().find((app) => app.host === requestHostname(request));
}
function headers(request: IncomingMessage, app: AppDefinition) {
  const result: http.OutgoingHttpHeaders = {
    ...request.headers,
    host: app.proxy.headerUpHost ?? app.host,
  };
  delete result["x-localdeck-action"];
  return result;
}

export function createGateway(
  store: LocaldeckStoreLike,
  supervisor: AppSupervisor,
) {
  const sockets = new Set<Duplex>();
  async function ready(app: AppDefinition): Promise<AppDefinition> {
    if (!usesGateway(app))
      throw new PublicError("このアプリのゲートウェイは無効です", 404);
    await supervisor.wake(app.id);
    // The app's assigned port may have changed during wake-up.
    const current = store.getApp(app.id);
    if (!current) throw new PublicError("アプリが見つかりません", 404);
    return current;
  }
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    app: AppDefinition,
  ): Promise<void> {
    const finish = supervisor.beginRequest(app.id);
    response.once("close", finish);
    response.once("finish", finish);
    try {
      const current = await ready(app);
      if (response.destroyed) return;
      const endpoint = parseUpstream(current.upstream)!;
      const upstream = http.request(
        {
          hostname: endpoint.address,
          port: endpoint.port,
          method: request.method,
          path: request.url,
          headers: headers(request, current),
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
          incoming.once("error", () => response.destroy());
        },
      );
      upstream.once("error", () => {
        if (!response.headersSent) {
          response.writeHead(502, {
            "Content-Type": "text/plain; charset=utf-8",
          });
          response.end(
            "アプリへ接続できません。Localdeckのログを確認してください。",
          );
        } else response.destroy();
      });
      request.once("aborted", () => upstream.destroy());
      response.once("close", () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(error instanceof PublicError ? error.status : 503, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "3",
        });
        response.end(errorMessage(error, "アプリを起動できませんでした"));
      }
      finish();
    }
  }
  async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const app = gatewayApp(request, store);
    if (!app) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.add(socket);
    const finish = supervisor.beginRequest(app.id);
    socket.once("close", () => {
      sockets.delete(socket);
      finish();
    });
    socket.on("error", () => socket.destroy());
    socket.once("end", () => socket.destroy());
    try {
      const current = await ready(app);
      if (socket.destroyed) return;
      const endpoint = parseUpstream(current.upstream)!;
      const upstream = http.request({
        hostname: endpoint.address,
        port: endpoint.port,
        method: request.method,
        path: request.url,
        headers: headers(request, current),
      });
      upstream.once("upgrade", (response, peer, upstreamHead) => {
        const responseHeaders = response.rawHeaders.reduce(
          (lines, value, index, values) =>
            index % 2 ? lines : lines + `${value}: ${values[index + 1]}\r\n`,
          "",
        );
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${responseHeaders}\r\n`,
        );
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) peer.write(head);
        sockets.add(peer);
        peer.once("close", () => {
          sockets.delete(peer);
          socket.destroy();
        });
        socket.once("close", () => peer.destroy());
        peer.on("error", () => socket.destroy());
        peer.once("end", () => {
          peer.destroy();
          socket.destroy();
        });
        peer.pipe(socket);
        socket.pipe(peer);
      });
      upstream.once("response", (response) => {
        response.resume();
        socket.end(
          `HTTP/1.1 ${response.statusCode ?? 502} Upgrade Failed\r\nConnection: close\r\n\r\n`,
        );
      });
      upstream.once("error", () => socket.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.end();
    } catch {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      finish();
    }
  }
  return {
    handle,
    upgrade,
    dispose: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
