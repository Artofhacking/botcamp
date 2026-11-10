import { firstNonEmpty } from "@botcamp/core/env-name";
/**
 * Operator-declared input modalities for `local` and `openai-compatible`
 * endpoints. They default to text-only because guessing "image" would send
 * computer-tool screenshots into a model that cannot see; operators fronting
 * a vision model through a gateway declare it here.
 */

/** Comma-separated model ids the operator declares vision-capable. */
export function declaredVisionModelIds(envName: string): ReadonlySet<string> {
  const suffix = envName.replace(/^(?:BOTCAMP_|RAKAZO_)/, "");
  const raw =
    envName === suffix
      ? process.env[envName]
      : firstNonEmpty(process.env[`BOTCAMP_${suffix}`], process.env[`RAKAZO_${suffix}`]);
  return new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function inputModalities(acceptsImages: boolean): ("text" | "image")[] {
  return acceptsImages ? ["text", "image"] : ["text"];
}
