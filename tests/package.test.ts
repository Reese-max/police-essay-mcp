import { test } from "node:test";
import { checkPackage } from "../scripts/check-package.js";

test("nested font and credential packaging rules cover synthetic fixtures", async () => { await checkPackage(true); });

test("Docker build context excludes real nested synthetic fonts, env files and keys", async t => {
  if (!await checkPackage()) t.skip("Docker 未啟用或本機無法執行；實際 build context 未驗證。");
});
