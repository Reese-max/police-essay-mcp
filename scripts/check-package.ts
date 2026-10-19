import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const required = ["**/.env*", "**/*.ttf", "**/*.otf", "**/*.ttc", "**/*.woff*", "**/*.pem", "**/*.key",
  "**/*.p12", "**/*.pfx", "**/fonts/", "**/credentials/", "**/secrets/", "**/*credentials*.json", "**/*service-account*.json"];
export async function checkPackage(staticOnly = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "essay-package-"));
  const context = path.join(root, "context"), output = path.join(root, "output");
  const sensitive = ["font.ttf", "font.otf", "font.ttc", "font.woff", "font.woff2", ".env", ".env.local", ".env.example",
    "cert.pem", "private.key", "cert.p12", "cert.pfx", "fonts/LICENSE", "credentials/account.json", "secrets/value",
    "my-credentials.json", "service-account-test.json"];
  try {
    for (const prefix of ["", "src/", "assets/nested/", "templates/nested/"]) {
      for (const name of [...sensitive, "safe.txt"]) {
        const target = path.join(context, prefix, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "synthetic fixture; no real credential or font");
      }
    }
    for (const file of [".dockerignore", ".gcloudignore"]) {
      const rules = (await readFile(path.resolve(file), "utf8")).split(/\r?\n/).map(s => s.trim());
      for (const rule of required) assert.ok(rules.includes(rule), file + " missing " + rule);
      assert.ok(!rules.some(s => s.startsWith("!")), file + " must not reinclude sensitive files");
    }
    await copyFile(path.resolve(".dockerignore"), path.join(context, ".dockerignore"));
    await writeFile(path.join(context, "Dockerfile"), "FROM scratch\nCOPY . /context/\n");
    let docker: ReturnType<typeof spawnSync> | undefined;
    if (!staticOnly) {
      try { docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 10_000, windowsHide: true }); }
      catch { /* Docker execution is unavailable in this environment. */ }
    }
    if (!docker || docker.error || docker.status !== 0) {
      console.log("PACKAGE_STATIC_OK fixture=root+src+assets+templates; Docker context 未驗證：Docker 未啟用、不可用或 --static-only。");
      return false;
    }
    const build = spawnSync("docker", ["build", "--progress=plain", "--output", "type=local,dest=" + output, context],
      { encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      return (await Promise.all(entries.map(async entry => entry.isDirectory()
        ? walk(path.join(dir, entry.name)) : [path.relative(path.join(output, "context"), path.join(dir, entry.name)).replaceAll("\\", "/")]))).flat();
    };
    const shipped = await walk(path.join(output, "context"));
    for (const prefix of ["", "src/", "assets/nested/", "templates/nested/"]) {
      assert.ok(shipped.includes(prefix + "safe.txt"));
      for (const name of sensitive) assert.ok(!shipped.includes(prefix + name), "sensitive fixture shipped: " + prefix + name);
    }
    console.log("PACKAGE_DOCKER_OK nested sensitive fixtures excluded from actual build context");
    return true;
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkPackage(process.argv.includes("--static-only"));
