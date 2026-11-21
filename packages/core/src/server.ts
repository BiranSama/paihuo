import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SystemInfo } from "@paihuo/shared";
import { WebSocketServer } from "ws";
import type { CoreApi } from "./api";
import { FRAME_BYTES } from "./api/protocol";
import { createTransport } from "./api/transport";

const protocol = "paihuo.v1";
const loopback = "127.0.0.1";

export async function startCore(options: {
  token: string;
  origin: string;
  systemInfo: () => SystemInfo;
  api?: CoreApi;
}) {
  const expectedToken = Buffer.from(options.token);
  const server = createServer({ headersTimeout: 5_000 }, (_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: FRAME_BYTES,
    handleProtocols: (protocols) => (protocols.has(protocol) ? protocol : false),
  });
  const transport = createTransport(sockets.clients, options.systemInfo, options.api);

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
      connection.on("error", (error) => {
        // ws 已为超限文本启动 1009 关闭握手；提前销毁底层 socket 会让客户端只能收到 1006。
        if (
          "code" in error &&
          error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" &&
          connection.readyState === connection.CLOSING
        )
          return;
        connection.terminate();
      });
      connection.on("message", (data, isBinary) => {
        let message: unknown;
        try {
          if (isBinary) {
            connection.close(1008, "Invalid request");
            return;
          }
          message = JSON.parse(data.toString());
        } catch {
          connection.close(1008, "Invalid request");
          return;
        }
        transport.receive(connection, message);
      });
    });
  });

  server.listen(0, loopback);
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        transport.close();
        for (const connection of sockets.clients) connection.terminate();
        sockets.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
