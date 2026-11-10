import { firstNonEmpty } from "@botcamp/core/env-name";
/**
 * Local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, MLX).
 * Kept apart from pi-local-provider.ts so the runtime limits can name it without loading the provider.
 */
export const LOCAL_PROVIDER_ID = "local";

/** Comma-separated model ids exactly as the local server names them. */
export function localModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (firstNonEmpty(env.BOTCAMP_LOCAL_MODELS, env.RAKAZO_LOCAL_MODELS) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
