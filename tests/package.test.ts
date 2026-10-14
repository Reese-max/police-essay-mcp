import { test } from "node:test";
import { checkPackage } from "../scripts/check-package.js";

test("nested font and credential packaging rules cover synthetic fixtures", () => checkPackage(true));
