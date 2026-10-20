import { FileStore, type EssayStore } from "./storage.js";

// The Google Cloud SDKs cost ~1.5s to load; only pay for them when the cloud backend is selected.
export async function createRuntimeStore(env: NodeJS.ProcessEnv = process.env): Promise<EssayStore> {
  if (env.MCP_TRANSPORT === "stdio" || !env.STORAGE_BACKEND || env.STORAGE_BACKEND === "file") {
    return new FileStore({ templateDir: env.ESSAY_MCP_TEMPLATE_DIR,
      answerDir: env.ESSAY_MCP_ANSWER_DIR, exportDir: env.ESSAY_MCP_EXPORT_DIR });
  }
  return (await import("./cloud-storage.js")).createRuntimeStore(env);
}
