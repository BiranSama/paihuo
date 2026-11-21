import type { Store } from "../store";
import { interruptedRunNotice } from "../store/dispatch";
import type { DispatchEvent } from "./events";

export function recoverInterrupted(store: Store, emit: (event: DispatchEvent) => void) {
  for (
    let scope = store.dispatch.nextInterruptedScope();
    scope;
    scope = store.dispatch.nextInterruptedScope()
  ) {
    const { session_id, conversation_id, work_item_id } = scope;
    const message = store.dispatch.transaction(() => {
      const notice = store.messages.append({
        id: crypto.randomUUID(),
        conversation_id,
        work_item_id,
        author_kind: "system",
        author_id: null,
        body: interruptedRunNotice,
        created_at: new Date().toISOString(),
      });
      store.dispatch.markRecoveryNotified(session_id, conversation_id, work_item_id);
      return notice;
    });
    emit({ type: "message.created", message, sessionId: session_id, runId: null });
  }
}
