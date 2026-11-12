import type {
  AdapterContext,
  MessagingInboundEvent,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { linkableChatApps } from "@rakazo/core";
import type { PersonalChatBridge } from "./bridge.js";
import { parsePersonalChatThreadId } from "./bridge.js";

/** Sends personal-chat replies without listing that app as a code-link provider. */
export class PersonalChatSurface implements MessagingSurface {
  constructor(
    private readonly bridge: PersonalChatBridge,
    private readonly fallback?: MessagingSurface,
  ) {}

  describe() {
    return (
      this.fallback?.describe() ?? {
        id: "personal-chat",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { providers: [] as string[] },
      }
    );
  }

  platforms() {
    return this.fallback?.platforms() ?? [];
  }

  handleWebhook(provider: string, request: Request) {
    return this.fallback?.handleWebhook(provider, request) ?? null;
  }

  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>) {
    this.bridge.onInbound((message) => sink(message));
    this.fallback?.onInbound(sink);
  }

  async sendToThread(
    request: MessagingSendRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult> {
    if (parsePersonalChatThreadId(request.threadId)) {
      return this.bridge.send(request.threadId, request.body);
    }
    if (!this.fallback) throw new Error("Messaging provider unavailable");
    return this.fallback.sendToThread(request, context);
  }

  openDirectThread(provider: string, address: string, context: AdapterContext) {
    if (linkableChatApps().includes(provider)) {
      return this.bridge.openDirect(provider, address, context);
    }
    if (!this.fallback) throw new Error("Messaging provider unavailable");
    return this.fallback.openDirectThread(provider, address, context);
  }

  acknowledge(threadId: string, handle: string, context: AdapterContext) {
    if (parsePersonalChatThreadId(threadId)) return Promise.resolve();
    return this.fallback?.acknowledge(threadId, handle, context) ?? Promise.resolve();
  }

  async initialize() {
    await this.fallback?.initialize?.();
    this.bridge.startWatching();
  }

  async shutdown() {
    await this.bridge.stopWatching();
    await this.fallback?.shutdown?.();
  }
}
