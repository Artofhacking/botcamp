import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The bots' traffic relay: a computer that has the switch on sends its TCP through the user's
 * desktop. The computer reaches a SOCKS endpoint on the web service, which forwards to the API
 * with the computer's own key; only the API and the supervisor derive that key.
 */
export const COMPUTER_RELAY_PATH = "/internal/computer-relay";
/** The port the web service listens on, inside each computer's Docker network. */
export const COMPUTER_RELAY_PORT = 1080;
/** The name the supervisor gives the web service in every computer network. */
export const COMPUTER_RELAY_HOST = "botcamp-proxy";

/** What the computer is told to use, including its own credentials. */
export function computerRelayUrl(secret: string, computerKey: string, port = COMPUTER_RELAY_PORT) {
  const key = computerRelayKey(secret, computerKey);
  return `socks5h://${encodeURIComponent(computerKey)}:${key}@${COMPUTER_RELAY_HOST}:${port}`;
}

/** Derived, so the supervisor never stores or ships a secret of its own per computer. */
export function computerRelayKey(secret: string, computerKey: string): string {
  return createHmac("sha256", secret).update(`computer-relay:${computerKey}`).digest("hex");
}

export function validComputerRelayKey(
  secret: string,
  computerKey: string,
  supplied: string | null | undefined,
): boolean {
  if (typeof supplied !== "string" || supplied.length !== 64) return false;
  const expected = Buffer.from(computerRelayKey(secret, computerKey));
  const given = Buffer.from(supplied);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
