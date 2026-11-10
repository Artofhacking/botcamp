import { z } from "zod";

/** First-party apps that can send a chat message. Chat channels are not in this list. */
export const AppMessageOriginSchema = z.enum(["web", "mac", "windows", "linux", "android"]);

export type AppMessageOrigin = z.infer<typeof AppMessageOriginSchema>;
