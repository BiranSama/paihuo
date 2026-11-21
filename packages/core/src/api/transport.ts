import type { SystemInfo } from "@paihuo/shared";
import type { WebSocket } from "ws";
import type { DispatchEvent } from "../dispatch";
import { packEvent, packReply } from "./bounds";
import { type CoreApi, handleMessage } from "./index";
import { FRAME_BYTES } from "./protocol";

export function sendFrame(socket: WebSocket, text: string) {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount + Buffer.byteLength(text) > 2 * FRAME_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(text, (error) => {
    if (error) socket.terminate();
  });
}

export function createTransport(
  clients: ReadonlySet<WebSocket>,
  systemInfo: () => SystemInfo,
  api?: CoreApi,
) {
  const ready = new WeakSet<WebSocket>();
  let commandEvents: DispatchEvent[] | undefined;
  function broadcast(event: DispatchEvent) {
    const frame = packEvent(event);
    for (const client of clients) if (ready.has(client)) sendFrame(client, frame);
  }
  const unsubscribe = api?.subscribe((event) => {
    // 命令提交期间的同步事件在回执后发送；异步调度事件到达时直接广播。
    if (commandEvents) commandEvents.push(event);
    else broadcast(event);
  });
  return {
    receive(socket: WebSocket, message: unknown) {
      const events: DispatchEvent[] = [];
      commandEvents = events;
      try {
        const response = handleMessage(message, systemInfo, api);
        sendFrame(socket, packReply(response));
        if ("result" in response) ready.add(socket);
      } finally {
        commandEvents = undefined;
        for (const event of events) broadcast(event);
      }
    },
    close: () => unsubscribe?.(),
  };
}
