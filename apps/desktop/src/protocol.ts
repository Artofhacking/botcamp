/** Arguments for registering the desktop return scheme with the OS. */
export function desktopProtocolRegistration(
  packaged: boolean,
  execPath: string,
  argv: readonly string[],
): { scheme: "botcamp"; exec?: string; args?: string[] } | null {
  if (packaged) return { scheme: "botcamp" };
  const script = argv[1];
  if (!script) return null;
  return { scheme: "botcamp", exec: execPath, args: [script] };
}

/** The `botcamp://` argument a second launch or a cold start was given. */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("botcamp://")) ?? null;
}
