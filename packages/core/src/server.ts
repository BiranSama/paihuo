import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SystemInfo, SystemInfoRequest, SystemInfoResponse } from "@paihuo/shared";
import { WebSocketServer } from "ws";

const protocol = "paihuo.v1";
const loopback = "127.0.0.1";

function isSystemInfoRequest(message: unknown): message is SystemInfoRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    typeof message.id === "string" &&
    message.id.length > 0 &&
    message.id.length <= 128 &&
    "method" in message &&
    message.method === "system.info"
  );
}

export async function startCore(options: {
  token: string;
  origin: string;
  systemInfo: () => SystemInfo;
}) {
  const expectedToken = Buffer.from(options.token);
  const server = createServer({ headersTimeout: 5_000 }, (_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    handleProtocols: (protocols) => (protocols.has(protocol) ? protocol : false),
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    const protocols = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((part) => part.trim());
    const receivedToken = protocols?.[1];
    const authorized =
      request.url === "/" &&
      (origin === undefined || origin === options.origin) &&
      protocols?.length === 2 &&
      protocols[0] === protocol &&
      typeof receivedToken === "string" &&
      /^[a-f0-9]{64}$/.test(receivedToken) &&
      timingSafeEqual(Buffer.from(receivedToken), expectedToken);

    if (!authorized) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on("error", () => connection.terminate());
      connection.on("message", (data, isBinary) => {
        let message: unknown;
        try {
          if (!isBinary) message = JSON.parse(data.toString());
        } catch {
          // 格式错误的消息统一按协议错误关闭。
        }

        if (!isSystemInfoRequest(message)) {
          connection.close(1008, "Invalid request");
          return;
        }

        const response: SystemInfoResponse = { id: message.id, result: options.systemInfo() };
        connection.send(JSON.stringify(response));
      });
    });
  });

  server.listen(0, loopback);
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const connection of sockets.clients) connection.terminate();
        sockets.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
