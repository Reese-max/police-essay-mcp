import { Timestamp } from "@google-cloud/firestore";
import type { FirestoreClient, StorageClient } from "../../src/cloud-storage.js";

type Data = Record<string, unknown>;
export type Read = { path: string; revision: number; value?: Data };
export type Write = { path: string; value: Data; create: boolean; delete?: boolean };
function clone<T>(value: T): T {
  if (value instanceof Timestamp) return Timestamp.fromMillis(value.toMillis()) as T;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object") {
    if (value.constructor.name === "ServerTimestampTransform") return Timestamp.now() as T;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

/** Optimistic, atomic commit: no shared promise lock and no lock across answers. */
export class MemoryFirestore {
  readonly documents = new Map<string, { revision: number; value: Data }>();
  retries = 0;
  failManifest = false;
  failRead = false;
  onTransactionRead?: (read: Read) => Promise<void>;
  client(): FirestoreClient { return this as unknown as FirestoreClient; }
  async read(path: string): Promise<Read> {
    if (this.failRead) throw new Error("synthetic dependency failure");
    const item = this.documents.get(path);
    return { path, revision: item?.revision ?? 0, value: item && clone(item.value) };
  }
  async commit(reads: Read[], writes: Write[]): Promise<boolean> {
    // No await between validation and application: all writes commit together.
    if (reads.some(read => (this.documents.get(read.path)?.revision ?? 0) !== read.revision)) return false;
    if (writes.some(write => write.create && this.documents.has(write.path))) throw new Error("Already exists.");
    if (this.failManifest && writes.some(write => write.path.includes("/artifacts/"))) throw new Error("synthetic manifest failure");
    for (const write of writes) {
      if (write.delete) { this.documents.delete(write.path); continue; }
      const revision = (this.documents.get(write.path)?.revision ?? 0) + 1;
      this.documents.set(write.path, { revision, value: clone(write.value) });
    }
    return true;
  }
  doc(path: string) {
    return {
      path,
      get: async () => { const read = await this.read(path); return { data: () => read.value }; },
      create: async (value: Data) => {
        await this.commit([], [{ path, value, create: true }]);
      },
      collection: (name: string) => this.collection(path + "/" + name),
    };
  }
  collection(path: string) {
    let order: string | undefined;
    let maximum = Infinity;
    const filters: Array<[string, unknown]> = [];
    const query = {
      doc: (id: string) => this.doc(path + "/" + id),
      orderBy: (field: string, _direction: string) => { order = field; return query; },
      limit: (limit: number) => { maximum = limit; return query; },
      where: (field: string, operator: "==", value: unknown) => {
        if (operator !== "==") throw new Error("Only == filters are faked.");
        filters.push([field, value]);
        return query;
      },
      get: async () => {
        if (this.failRead) throw new Error("synthetic dependency failure");
        const entries = [...this.documents.entries()].filter(([key, item]) =>
          key.startsWith(path + "/") && key.slice(path.length + 1).indexOf("/") === -1
          && filters.every(([field, value]) => item.value[field] === value));
        if (order) entries.sort((a, b) => String(b[1].value[order!]).localeCompare(String(a[1].value[order!])));
        return { docs: entries.slice(0, maximum).map(([key, item]) => ({ ref: this.doc(key), data: () => clone(item.value) })) };
      },
    };
    return query;
  }
  async runTransaction<T>(callback: (transaction: {
    get: (ref: { path: string } | { get: () => Promise<{ docs: Array<{ ref: { path: string } }> }> }) => Promise<unknown>;
    set: (ref: { path: string }, value: Data) => void;
    create: (ref: { path: string }, value: Data) => void;
    delete: (ref: { path: string }) => void;
  }) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reads: Read[] = [];
      const writes: Write[] = [];
      const result = await callback({
        get: async ref => {
          if (!("path" in ref)) {
            // Query read: every returned document joins the optimistic read set.
            const snapshot = await ref.get();
            for (const doc of snapshot.docs) reads.push(await this.read(doc.ref.path));
            return snapshot;
          }
          const read = await this.read(ref.path);
          reads.push(read);
          await this.onTransactionRead?.(read);
          return { data: () => clone(read.value) };
        },
        set: (ref, value) => { writes.push({ path: ref.path, value, create: false }); },
        create: (ref, value) => { writes.push({ path: ref.path, value, create: true }); },
        delete: ref => { writes.push({ path: ref.path, value: {}, create: false, delete: true }); },
      });
      if (await this.commit(reads, writes)) return result;
      this.retries++;
    }
    throw new Error("Transaction retries exhausted.");
  }
}

export class MemoryStorage {
  readonly objects = new Map<string, { data: Buffer; generation: string }>();
  private nextGeneration = 1;
  failUpload = false;
  failDelete = false;
  failRead = false;
  failMetadata = false;
  saveResponseLost?: "same" | "different" | "different-size";
  uploads = 0;
  downloads = 0;
  deletions = 0;
  client(): StorageClient { return this as unknown as StorageClient; }
  bucket(bucket: string) {
    const file = (name: string, options: { generation?: string } = {}) => {
      const key = bucket + "/" + name;
      const get = () => {
        if (this.failRead) throw new Error("synthetic storage read failure");
        const object = this.objects.get(key);
        if (!object || (options.generation && options.generation !== object.generation)) throw Object.assign(new Error("Object not found."), { code: 404 });
        return object;
      };
      return {
        save: async (data: Buffer, options: { preconditionOpts: { ifGenerationMatch: number } }) => {
          this.uploads++;
          if (this.failUpload) throw new Error("synthetic upload failure");
          if (options.preconditionOpts.ifGenerationMatch !== 0 || this.objects.has(key)) throw Object.assign(new Error("Object precondition failed."), { code: 412 });
          this.objects.set(key, { data: this.saveResponseLost === "different" ? Buffer.alloc(data.length, 120)
            : this.saveResponseLost === "different-size" ? Buffer.alloc(data.length + 1, 120) : Buffer.from(data), generation: String(this.nextGeneration++) });
          if (this.saveResponseLost) throw Object.assign(new Error("lost response, retry precondition failed"), { code: 412 });
        },
        getMetadata: async () => {
          if (this.failMetadata) throw new Error("synthetic metadata failure");
          const object = get();
          return [{ generation: object.generation, size: String(object.data.length) }];
        },
        download: async (range?: { start: number; end: number }) => {
          this.downloads++;
          const data = get().data;
          return [Buffer.from(range ? data.subarray(range.start, range.end + 1) : data)];
        },
        delete: async (precondition: { ifGenerationMatch: string }) => {
          this.deletions++;
          if (this.failDelete) throw new Error("synthetic compensation failure");
          const object = get();
          if (precondition.ifGenerationMatch !== object.generation) throw new Error("Delete precondition failed.");
          this.objects.delete(key);
        },
      };
    };
    return {
      file,
      getFiles: async (options: { prefix?: string } = {}) => {
        if (this.failRead) throw new Error("synthetic storage read failure");
        return [[...this.objects.keys()].filter(key => key.startsWith(bucket + "/" + (options.prefix ?? ""))).slice(0, 1).map(key => file(key.slice(bucket.length + 1)))];
      },
    };
  }
}
