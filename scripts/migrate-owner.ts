/**
 * Copy one owner's answers, revisions and exams to another owner key, e.g. from the fixed bearer owner
 * (ESSAY_OWNER_KEY) to the key an OAuth sign-in maps to (SHA-256 of [issuer, sub]).
 *
 *   npx tsx scripts/migrate-owner.ts --environment staging --from <64-hex> --issuer <iss> --sub <sub> [--apply]
 *
 * Dry run by default. Source data is never changed or deleted; a destination that already has answers is refused,
 * and every write is a create, so an interrupted run never overwrites. Export artifacts are not copied: their
 * objects live under the old owner's prefix, and exports can be generated again.
 */
import { pathToFileURL } from "node:url";
import { principalOwnerKey } from "../src/oauth.js";
import type { FirestoreClient } from "../src/cloud-storage.js";

type Snapshot = { docs: Array<{ ref: { path: string }; data: () => Record<string, unknown> | undefined }> };
const COLLECTIONS = ["answers", "exams", "examCreateKeys"] as const;
const KEY = /^[a-f0-9]{64}$/;

export type MigrationReport = { from: string; to: string; applied: boolean; documents: Record<string, number>; artifactsSkipped: number };

export async function migrateOwner(firestore: FirestoreClient, options: { environment: string; from: string; to: string; apply?: boolean }): Promise<MigrationReport> {
  const { environment, from, to } = options;
  if (!/^[a-z0-9-]+$/.test(environment)) throw new Error("Invalid environment.");
  if (!KEY.test(from) || !KEY.test(to)) throw new Error("Owner keys must be 64 lowercase hex characters.");
  if (from === to) throw new Error("Source and destination owner keys are the same.");
  const root = (owner: string) => `essayEnvironments/${environment}/users/${owner}`;
  const list = async (path: string) => (await firestore.collection(path).get()) as unknown as Snapshot;
  if ((await list(root(to) + "/answers")).docs.length) throw new Error("Destination owner already has answers; refusing to merge.");

  const plan: Array<{ path: string; value: Record<string, unknown> }> = [];
  const documents: Record<string, number> = {};
  const add = (kind: string, sourcePath: string, value: Record<string, unknown> | undefined) => {
    if (!value) return;
    documents[kind] = (documents[kind] ?? 0) + 1;
    plan.push({ path: root(to) + sourcePath.slice(root(from).length),
      value: "ownerKey" in value ? { ...value, ownerKey: to } : value });
  };
  for (const name of COLLECTIONS) {
    for (const doc of (await list(root(from) + "/" + name)).docs) {
      add(name, doc.ref.path, doc.data());
      if (name === "answers") for (const revision of (await list(doc.ref.path + "/revisions")).docs) add("revisions", revision.ref.path, revision.data());
    }
  }
  const artifactsSkipped = (await list(root(from) + "/artifacts")).docs.length;
  if (options.apply) for (const item of plan) await (firestore.doc(item.path) as unknown as { create: (value: unknown) => Promise<unknown> }).create(item.value);
  return { from, to, applied: !!options.apply, documents, artifactsSkipped };
}

async function main(argv: string[]) {
  const arg = (name: string) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : undefined; };
  const environment = arg("environment"), from = arg("from"), issuer = arg("issuer"), sub = arg("sub");
  const to = arg("to") ?? (issuer && sub ? principalOwnerKey(issuer, sub) : undefined);
  if (!environment || !from || !to) throw new Error("Usage: --environment <env> --from <owner key> (--to <owner key> | --issuer <iss> --sub <sub>) [--apply]");
  const { Firestore } = await import("@google-cloud/firestore");
  const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT, databaseId: process.env.ESSAY_FIRESTORE_DATABASE });
  console.log(JSON.stringify(await migrateOwner(firestore as unknown as FirestoreClient, { environment, from, to, apply: argv.includes("--apply") }), null, 1));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
