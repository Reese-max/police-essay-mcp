import assert from "node:assert/strict";
import { test } from "node:test";
import { renameReplacing } from "../src/storage.js";

const failing = (code: string) => Object.assign(new Error(`${code}: rename`), { code });

test("renameReplacing retries a briefly locked target and then succeeds", async () => {
  let calls = 0;
  await renameReplacing("a.tmp", "a.json", async () => {
    calls += 1;
    if (calls <= 2) throw failing(calls === 1 ? "EPERM" : "EBUSY");
  });
  assert.equal(calls, 3);
});

test("renameReplacing reports other errors at once and gives up on a lock that stays", async () => {
  let calls = 0;
  await assert.rejects(renameReplacing("a.tmp", "a.json", async () => { calls += 1; throw failing("ENOENT"); }), /ENOENT/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(renameReplacing("a.tmp", "a.json", async () => { calls += 1; throw failing("EACCES"); }), /EACCES/);
  assert.equal(calls, 9);
});
