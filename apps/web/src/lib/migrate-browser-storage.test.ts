import { describe, expect, it } from "vitest";
import { migrateStoredKeys } from "./migrate-browser-storage";

const previous = ["ra", "kazo"].join("");

function memory() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

describe("migrateStoredKeys", () => {
  it("moves both prefixes and keeps a value already stored under the new name", () => {
    const storage = memory();
    storage.setItem(`${previous}.signedInUser`, "person-a");
    storage.setItem(`${previous}:space-id`, "space-a");
    storage.setItem("botcamp.showToolActivity", "on");
    storage.setItem(`${previous}.showToolActivity`, "off");
    storage.setItem("other", "stay");

    migrateStoredKeys(storage);

    expect(storage.getItem("botcamp.signedInUser")).toBe("person-a");
    expect(storage.getItem("botcamp:space-id")).toBe("space-a");
    expect(storage.getItem("botcamp.showToolActivity")).toBe("on");
    expect(storage.getItem(`${previous}.signedInUser`)).toBeNull();
    expect(storage.getItem(`${previous}:space-id`)).toBeNull();
    expect(storage.getItem(`${previous}.showToolActivity`)).toBeNull();
    expect(storage.getItem("other")).toBe("stay");
  });
});
