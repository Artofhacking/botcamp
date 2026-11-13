import type { Api, Model, MutableModels, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { canonicalPiProviderId } from "@botcamp/contracts";

/** Apply provider protocol capabilities before catalog and runtime selection. */
export function applyPiModelCompatibility(models: MutableModels): MutableModels {
  const provider = models.getProvider?.("amazon-bedrock");
  if (provider) {
    const guardedId = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
    const guardedModels = provider
      .getModels()
      .map((model) =>
        model.id === guardedId
          ? { ...model, compat: { ...model.compat, supportsStrictMode: false } }
          : model,
      );
    models.setProvider({ ...provider, getModels: () => guardedModels });
  }
  // Only OpenAI's own endpoints, and OpenRouter (which translates per model), accept the
  // developer role. Other chat templates know system/user/assistant/tool and reject the
  // whole request ("Unexpected message role") when a reasoning model sends developer.
  for (const compatible of models.getProviders?.() ?? []) {
    if (DEVELOPER_ROLE_PROVIDERS.has(compatible.id)) continue;
    const original = compatible.getModels();
    if (!original.some(defaultsToDeveloperRole)) continue;
    const systemModels = original.map((model) =>
      defaultsToDeveloperRole(model)
        ? { ...model, compat: { ...model.compat, supportsDeveloperRole: false } }
        : model,
    );
    models.setProvider({ ...compatible, getModels: () => systemModels });
  }
  const getModel = models.getModel.bind(models);
  models.getModel = (provider, id) => getModel(canonicalPiProviderId(provider), id);
  const getProvider = models.getProvider?.bind(models);
  if (getProvider) models.getProvider = (provider) => getProvider(canonicalPiProviderId(provider));
  routeGrokSubscription(models);
  return models;
}

/**
 * A Grok subscription sign-in is the same login Grok Build uses. Those calls go to its
 * proxy with the subscription auth kind, so usage draws on that subscription. An API key
 * stays on the provider's own endpoint and its own balance.
 */
export const GROK_SUBSCRIPTION_PROXY_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_SUBSCRIPTION_AUTH_HEADER = "x-xai-token-auth";
export const GROK_SUBSCRIPTION_AUTH_KIND = "xai-grok-cli";

function routeGrokSubscription(models: MutableModels): void {
  const provider = models.getProvider?.("xai");
  const oauth = provider?.auth.oauth;
  if (!provider || !oauth) return;
  const current = oauth.toAuth as OAuthAuth["toAuth"] & { grokSubscription?: boolean };
  if (current.grokSubscription) return;
  const toAuth = oauth.toAuth.bind(oauth);
  const wrapped: OAuthAuth["toAuth"] & { grokSubscription?: boolean } = async (
    credential: OAuthCredential,
  ) => {
    const auth = await toAuth(credential);
    return {
      ...auth,
      apiKey: auth.apiKey ?? credential.access,
      baseUrl: GROK_SUBSCRIPTION_PROXY_URL,
      headers: { ...auth.headers, [GROK_SUBSCRIPTION_AUTH_HEADER]: GROK_SUBSCRIPTION_AUTH_KIND },
    };
  };
  wrapped.grokSubscription = true;
  models.setProvider({
    ...provider,
    auth: { ...provider.auth, oauth: { ...oauth, toAuth: wrapped } },
  });
}

const DEVELOPER_ROLE_PROVIDERS = new Set(["openai", "azure", "openrouter"]);

/** A reasoning chat-completions model that pi would send the developer role by default. */
function defaultsToDeveloperRole(model: Model<Api>): boolean {
  if (model.api !== "openai-completions" || !model.reasoning) return false;
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return compat?.supportsDeveloperRole === undefined;
}
