// The previous prefix is split so a bulk rename does not rewrite the source it migrates from.
const PREVIOUS_NAME = ["ra", "kazo"].join("");
const OLD_PREFIXES = [`${PREVIOUS_NAME}.`, `${PREVIOUS_NAME}:`] as const;
const NEW_PREFIXES = ["botcamp.", "botcamp:"] as const;

/** Copy saved browser keys to the current prefix and drop the previous names. */
export function migrateStoredKeys(
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
): void {
  const renames: Array<[string, string]> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    for (let prefix = 0; prefix < OLD_PREFIXES.length; prefix += 1) {
      const previous = OLD_PREFIXES[prefix];
      const nextPrefix = NEW_PREFIXES[prefix];
      if (previous === undefined || nextPrefix === undefined || !key.startsWith(previous)) continue;
      renames.push([key, `${nextPrefix}${key.slice(previous.length)}`]);
    }
  }
  for (const [key, next] of renames) {
    if (key === next) continue;
    if (storage.getItem(next) === null) {
      const value = storage.getItem(key);
      if (value !== null) storage.setItem(next, value);
    }
    storage.removeItem(key);
  }
}

function storageOrNull(read: () => Storage): Storage | null {
  try {
    return read();
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  const local = storageOrNull(() => window.localStorage);
  const session = storageOrNull(() => window.sessionStorage);
  if (local) migrateStoredKeys(local);
  if (session) migrateStoredKeys(session);
}
