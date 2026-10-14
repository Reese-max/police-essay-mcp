import { CloudStore } from "../../src/cloud-storage.js";
import type { AnswerDocument } from "../../src/domain.js";
import { MemoryFirestore, MemoryStorage, type Read, type Write } from "./cloud-clients.js";

let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
function rpc(op: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send!({ id, op, args });
  });
}
class RemoteFirestore extends MemoryFirestore {
  override async read(path: string) { return await rpc("read", path) as Read; }
  override async commit(reads: Read[], writes: Write[]) { return await rpc("commit", { reads, writes }) as boolean; }
}
process.on("message", async (message: { id?: number; value?: unknown; error?: string; answer?: AnswerDocument; ownerKey?: string }) => {
  if (message.id) {
    const callback = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error));
    else callback.resolve(message.value);
    return;
  }
  if (!message.answer) return;
  const store = new CloudStore({ firestore: new RemoteFirestore().client(), storage: new MemoryStorage().client(),
    environment: "staging", ownerKey: message.ownerKey!, artifactBucket: "synthetic-artifacts" });
  try {
    await store.saveAnswer(message.answer, { expectedVersion: 1 });
    process.send!({ done: true, ok: true });
  } catch (error) {
    process.send!({ done: true, ok: false, error: (error as Error).message });
  } finally { process.disconnect(); }
});
process.send!({ ready: true });
