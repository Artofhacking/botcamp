import { describe, expect, it } from "vitest";
import { computerRelayKey, computerRelayUrl, validComputerRelayKey } from "./computer-relay.js";

describe("computer relay credentials", () => {
  it("derives one stable key per computer", () => {
    expect(computerRelayKey("secret", "home-1")).toBe(computerRelayKey("secret", "home-1"));
    expect(computerRelayKey("secret", "home-1")).not.toBe(computerRelayKey("secret", "home-2"));
    expect(computerRelayKey("secret", "home-1")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("puts the computer's identity in the URL the bot's computer uses", () => {
    const url = new URL(computerRelayUrl("secret", "home-1"));
    expect(url.protocol).toBe("socks5h:");
    expect(url.username).toBe("home-1");
    expect(url.password).toBe(computerRelayKey("secret", "home-1"));
    expect(url.hostname).toBe("botcamp-proxy");
    expect(url.port).toBe("1080");
  });

  it("accepts only the key derived for that computer", () => {
    const key = computerRelayKey("secret", "home-1");
    expect(validComputerRelayKey("secret", "home-1", key)).toBe(true);
    expect(validComputerRelayKey("secret", "home-2", key)).toBe(false);
    expect(validComputerRelayKey("other-secret", "home-1", key)).toBe(false);
    expect(validComputerRelayKey("secret", "home-1", null)).toBe(false);
  });
});
