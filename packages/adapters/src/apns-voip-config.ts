import type { ApnsVoipConfig } from "./apns-voip.js";

/** The deployment's own iOS bundle id; BotCamp has no shared upstream app. */
const DEFAULT_BUNDLE_ID = "";

export function apnsVoipConfig(
  source: Record<string, string | undefined>,
): ApnsVoipConfig | undefined {
  if (!source.APNS_VOIP_KEY_ID && !source.APNS_VOIP_TEAM_ID && !source.APNS_VOIP_PRIVATE_KEY)
    return undefined;
  if (!source.APNS_VOIP_KEY_ID || !source.APNS_VOIP_TEAM_ID || !source.APNS_VOIP_PRIVATE_KEY)
    throw new Error(
      "APNS_VOIP_KEY_ID, APNS_VOIP_TEAM_ID and APNS_VOIP_PRIVATE_KEY must be configured together.",
    );
  if (
    source.APNS_VOIP_ENVIRONMENT &&
    !["sandbox", "production"].includes(source.APNS_VOIP_ENVIRONMENT)
  )
    throw new Error("APNS_VOIP_ENVIRONMENT must be sandbox or production.");
  const bundleId = source.APNS_VOIP_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  if (!bundleId) throw new Error("APNS_VOIP_BUNDLE_ID must be configured.");
  return {
    keyId: source.APNS_VOIP_KEY_ID,
    teamId: source.APNS_VOIP_TEAM_ID,
    privateKey: source.APNS_VOIP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    environment: source.APNS_VOIP_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    bundleId,
  };
}

export async function createApnsVoipProvider(config: ApnsVoipConfig | undefined) {
  if (!config) return undefined;
  const { ApnsVoipProvider } = await import("./apns-voip.js");
  return new ApnsVoipProvider(config);
}
