import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";

// Observed: 400 "minijinja: rendering failed: raise_exception: Unexpected message role."
// Qwen-style chat templates only render system, user, assistant and tool.
it.each([
  ["groq", "openai/gpt-oss-20b"],
  ["groq", "openai/gpt-oss-120b"],
  ["groq", "qwen/qwen3.6-27b"],
  ["xiaomi", "mimo-v2.5"],
])("sends system instructions to the %s %s chat template", async (provider, id) => {
  const models = applyPiModelCompatibility(builtinModels());
  const model = models.getModel(provider, id);
  expect(model).toBeDefined();
  if (!model) return;
  let roles: string[] = [];
  const result = await models
    .streamSimple(
      model,
      {
        systemPrompt: "Fixture instructions.",
        messages: [{ role: "user", content: "Fixture request.", timestamp: 1 }],
      },
      {
        apiKey: "fixture-key",
        reasoning: "low",
        maxRetries: 0,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
          roles = body.messages.map((message) => message.role);
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    )
    .result();
  expect(result.stopReason).toBe("stop");
  expect(roles).toEqual(["system", "user"]);
});

describe("provider compatibility boundaries", () => {
  it("keeps other providers unchanged", () => {
    const original = builtinModels();
    const openai = original.getProvider("openai");
    expect(openai).toBeDefined();
    expect(applyPiModelCompatibility(original).getProvider("openai")).toBe(openai);
  });
});

function grokSignIn(): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60_000,
  };
}

describe("Grok subscription sign-in", () => {
  it("sends the sign-in to the subscription proxy and leaves an API key on the API", async () => {
    const signedIn = applyPiModelCompatibility(
      builtinModels({ credentials: new PiRuntimeCredentialStore("xai", grokSignIn()) }),
    );
    const subscription = await signedIn.getAuth("xai");
    expect(subscription?.auth).toMatchObject({
      apiKey: "access-token",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      headers: { "x-xai-token-auth": "xai-grok-cli" },
    });

    const keyed = applyPiModelCompatibility(
      builtinModels({
        credentials: new PiRuntimeCredentialStore("xai", { type: "api_key", key: "xai-test-key" }),
      }),
    );
    const apiKey = await keyed.getAuth("xai");
    expect(apiKey?.auth.apiKey).toBe("xai-test-key");
    expect(apiKey?.auth.baseUrl).toBeUndefined();
    expect(apiKey?.auth.headers?.["x-xai-token-auth"]).toBeUndefined();
  });

  it("puts the subscription auth on the request the model call makes", async () => {
    const models = applyPiModelCompatibility(
      builtinModels({ credentials: new PiRuntimeCredentialStore("xai", grokSignIn()) }),
    );
    const model = models.getModel("xai", "grok-4.6");
    expect(model).toBeDefined();
    let url = "";
    let authKind = "";
    let authorization = "";
    const result = await models
      .streamSimple(
        model!,
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        {
          maxRetries: 0,
          fetch: async (input, init) => {
            url = String(input);
            const headers = new Headers(init?.headers);
            authKind = headers.get("x-xai-token-auth") ?? "";
            authorization = headers.get("authorization") ?? "";
            return new Response("unauthorized", { status: 401 });
          },
        },
      )
      .result();
    expect(url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(authKind).toBe("xai-grok-cli");
    expect(authorization).toBe("Bearer access-token");
    expect(result.stopReason).toBe("error");
  });
});
