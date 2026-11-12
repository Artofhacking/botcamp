/** Arguments for registering the desktop return scheme with the OS. */
export function desktopProtocolRegistration(
  packaged: boolean,
  execPath: string,
  argv: readonly string[],
): { scheme: "rakazo"; exec?: string; args?: string[] } | null {
  if (packaged) return { scheme: "rakazo" };
  const script = argv[1];
  if (!script) return null;
  return { scheme: "rakazo", exec: execPath, args: [script] };
}

/** The `rakazo://` argument a second launch or a cold start was given. */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("rakazo://")) ?? null;
}
