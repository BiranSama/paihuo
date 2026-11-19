import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const firstSession = "00000000-0000-4000-8000-000000000003";
const secondSession = "00000000-0000-4000-8000-000000000004";
const toolUseId = "toolu_synthetic";

function streamFixture(sessionId, text, withTool) {
  // 合成流只包含检查所需字段。字段形状参考 Claude Agent SDK 的 TypeScript 文档。
  const messages = [
    { type: "system", subtype: "init" },
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    },
  ];

  if (withTool) {
    messages.push(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: toolUseId, name: "Read" }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 100_000 },
      },
    );
  }

  messages.push({ type: "result", subtype: "success" });
  const ndjson = messages
    .map((message) => JSON.stringify({ ...message, session_id: sessionId }))
    .join("\r\n");
  const bytes = Buffer.from(ndjson);
  // 故意拆开 UTF-8 的多字节字符，并让最后一行没有换行符。
  const split = bytes.indexOf(text) + 1;
  return [bytes.subarray(0, split), bytes.subarray(split)];
}

async function readSyntheticStream(chunks, sessionId) {
  const lines = createInterface({
    input: Readable.from(chunks),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const events = [];
  for await (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.session_id, sessionId, "wrong session");
    if (message.type === "stream_event" && message.event?.delta?.type === "text_delta") {
      events.push(["text", message.event.delta.text]);
    } else if (message.type === "assistant" || message.type === "user") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") events.push(["tool_use", block.id]);
        if (block.type === "tool_result") events.push(["tool_result", block.tool_use_id]);
      }
    } else {
      events.push([message.type, message.subtype]);
    }
  }
  return events;
}

export async function verifySyntheticStreams() {
  const [first, second] = await Promise.all([
    readSyntheticStream(streamFixture(firstSession, "甲", true), firstSession),
    readSyntheticStream(streamFixture(secondSession, "乙", false), secondSession),
  ]);
  assert.deepEqual(
    first,
    [
      ["system", "init"],
      ["text", "甲"],
      ["tool_use", toolUseId],
      ["tool_result", toolUseId],
      ["system", "compact_boundary"],
      ["result", "success"],
    ],
    "first stream event order",
  );
  assert.deepEqual(
    second,
    [
      ["system", "init"],
      ["text", "乙"],
      ["result", "success"],
    ],
    "second stream event order",
  );
  await assert.rejects(
    readSyntheticStream(streamFixture(secondSession, "乙", false), firstSession),
    /wrong session/,
  );
  await assert.rejects(readSyntheticStream([Buffer.from("{")], firstSession), SyntaxError);
}
