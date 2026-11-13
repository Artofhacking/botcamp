import { z } from "zod";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { hostComputerRequest } from "./host-computer-protocol.js";

export const userDeviceRevokeReason = z.enum(["session-ended"]);
/** Carries the revoke reason on a refused connection, which has no message to put it in. */
export const USER_DEVICE_REVOKED_HEADER = "x-rakazo-device-revoked";
export type UserDeviceRevokeReason = z.infer<typeof userDeviceRevokeReason>;

/** One chunk of a relayed TCP stream, before base64. */
export const USER_DEVICE_RELAY_CHUNK_BYTES = 64 * 1024;
/** The most one device may relay at once, so a runaway bot cannot exhaust its connection. */
export const USER_DEVICE_RELAY_LIMIT = 16;
/** A relay whose target sent this many unread bytes is closed instead of buffered forever. */
export const USER_DEVICE_RELAY_BUFFER_BYTES = 2 * 1024 * 1024;

const relayId = z.string().min(1).max(64);
const relayHost = z.string().min(1).max(253);
const relayPort = z.number().int().min(1).max(65_535);
const relayChunk = z
  .string()
  .max(Math.ceil((USER_DEVICE_RELAY_CHUNK_BYTES * 4) / 3) + 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const userDeviceServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    id: z.string().min(1).max(64),
    request: hostComputerRequest,
  }),
  z.object({ type: z.literal("cancel"), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("relay-open"), id: relayId, host: relayHost, port: relayPort }),
  z.object({ type: z.literal("relay-data"), id: relayId, data: relayChunk }),
  z.object({ type: z.literal("relay-close"), id: relayId }),
  // "session-ended": the sign-in that paired it ended, so the next sign-in pairs again.
  z.object({ type: z.literal("revoked"), reason: userDeviceRevokeReason.optional() }),
]);
export type UserDeviceServerMessage = z.infer<typeof userDeviceServerMessage>;

/** One HostComputerFrame per message, tagged with the request id. */
export const userDeviceClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), id: z.string().min(1).max(64), frame: z.unknown() }),
  /** Sent after connecting and whenever the switch changes; stored with the connected socket. */
  z.object({ type: z.literal("relay-state"), enabled: z.boolean() }),
  z.object({ type: z.literal("relay-data"), id: relayId, data: relayChunk }),
  z.object({ type: z.literal("relay-close"), id: relayId, error: z.string().max(200).optional() }),
]);
export type UserDeviceClientMessage = z.infer<typeof userDeviceClientMessage>;

export interface UserDevice {
  deviceId: string;
  name: string;
  platform: string;
}

export interface UserDeviceRelayTarget {
  host: string;
  port: number;
}

/** One relayed TCP connection: bytes to the target, and what the target sends back. */
export interface UserDeviceRelay {
  data: AsyncIterable<Buffer>;
  write(chunk: Buffer): void;
  /** Half-close: the target sees end of stream, and `data` ends when it closes too. */
  end(): void;
}

/** How runs reach the requesting user's connected device, from any API or worker process. */
export interface UserDeviceGateway {
  connected(userId: string): Promise<UserDevice | null>;
  /** When the oldest device still paired was paired, connected or not; null when none is. */
  pairedSince(userId: string): Promise<Date | null>;
  /**
   * Streams HostComputerFrame values for one request. Throws when the device is offline,
   * revoked, or disconnects mid-request; a command is never retried after a lost response.
   * Pass `deviceId` to keep every request of one operation on the same computer.
   */
  request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T>;
  /** Optional so fixtures that only run commands need no relay. */
  relaying?(userId: string): Promise<boolean>;
  /**
   * Opens a TCP connection from the user's computer to the target, so its traffic leaves from
   * that network. Throws when no connected computer allows relay or it cannot connect.
   */
  relay?(
    userId: string,
    target: UserDeviceRelayTarget,
    signal: AbortSignal,
  ): Promise<UserDeviceRelay>;
}
