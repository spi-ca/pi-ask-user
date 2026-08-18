// Shared V2 consumer handles connected through a test event bus.

import { createPresenceConsumer, type PresenceEventV2 } from "@pi/presence";

export const QUESTIONNAIRE_SENTINELS = Object.freeze([
  "question-id-sentinel-8d2e",
  "question-label-sentinel-8d2e",
  "question-prompt-sentinel-8d2e",
  "option-value-sentinel-8d2e",
  "option-label-sentinel-8d2e",
  "option-description-sentinel-8d2e",
  "answer-sentinel-8d2e",
  "cancel-reason-sentinel-8d2e",
  "session-path-sentinel-8d2e",
]);

type Listener = (eventName: string, payload: unknown) => void;

/** A synchronous in-process event bus matching the extension event-bus fanout. */
export function createEventBus() {
  const listeners = new Set<Listener>();
  const emitted: Array<{ eventName: string; payload: unknown }> = [];
  return {
    emitted,
    emit(eventName: string, payload: unknown): void {
      emitted.push({ eventName, payload });
      for (const listener of [...listeners]) listener(eventName, payload);
    },
    on(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function attachV2Consumer(
  bus: ReturnType<typeof createEventBus>,
  id: "pi-cmux-presence" | "pi-herdr-presence" = "pi-cmux-presence",
) {
  const consumer = createPresenceConsumer({ id });
  if (!consumer) throw new Error("V2 consumer creation failed");
  const received: PresenceEventV2[] = [];
  const unsubscribe = bus.on((eventName, payload) => {
    const accepted = consumer.accept(eventName, payload);
    if (accepted) received.push(accepted);
  });
  if (!consumer.activate((eventName, payload) => bus.emit(eventName, payload))) {
    unsubscribe();
    throw new Error("V2 consumer activation failed");
  }
  return {
    received,
    deactivate(): void {
      unsubscribe();
      consumer.deactivate();
    },
  };
}

export function serializedPayloadsArePrivate(payloads: readonly unknown[]): boolean {
  return payloads.every((payload) => {
    const serialized = JSON.stringify(payload);
    return (
      !Object.hasOwn(payload as object, "sessionId") &&
      QUESTIONNAIRE_SENTINELS.every((sentinel) => !serialized.includes(sentinel))
    );
  });
}
