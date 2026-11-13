import { SandboxDamagedError } from "@botcamp/adapter-kit";
import type { AdapterContext, ComputerRef } from "@botcamp/adapter-kit";
import { describe, expect, it } from "vitest";
import { ExecComputer } from "./exec-computer.js";

const computer: ComputerRef = {
  id: "pod",
  botId: "bot",
  kind: "kubernetes",
  providerRef: "pod",
};
const context = { signal: new AbortController().signal } as AdapterContext;

describe("ExecComputer.prepare", () => {
  it("reports a machine that cannot run its prepare script as damaged", async () => {
    const shell = new ExecComputer(async function* () {
      yield { type: "exit", code: 1 };
    }, "Kubernetes");

    const error = await shell.prepare(computer, context).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SandboxDamagedError);
    expect(error).toMatchObject({
      cause: { message: "could not prepare Kubernetes computer" },
    });
  });
});
