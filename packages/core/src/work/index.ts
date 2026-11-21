import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkItem } from "@paihuo/shared";
import type { Store } from "../store";

export interface StartWorkInput {
  memberId: string;
  conversationId: string;
  title: string;
  goal: string;
}

export function createWork<T>(store: Store, input: StartWorkInput, enqueue: (item: WorkItem) => T) {
  if (store.dispatch.dmRecipient(input.conversationId) !== input.memberId)
    throw new Error("该私聊与工作负责人不匹配");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const item: WorkItem = {
    id,
    title: input.title,
    goal: input.goal,
    owner_member_id: input.memberId,
    status: "running",
    conversation_id: input.conversationId,
    dir: join(store.dataDir, "work", id),
    created_at: now,
    updated_at: now,
  };
  mkdirSync(item.dir);
  try {
    return store.dispatch.transaction(() => {
      store.workItems.insert(item);
      return { item, queued: enqueue(item) };
    });
  } catch (error) {
    // 只撤销本次创建的空目录。
    rmdirSync(item.dir);
    throw error;
  }
}

export function completeWork(store: Store, item: WorkItem): WorkItem {
  const updated: WorkItem = { ...item, status: "done", updated_at: new Date().toISOString() };
  store.workItems.update(updated);
  return updated;
}
