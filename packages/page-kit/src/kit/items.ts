import { isValidElement, type ReactNode } from "react";

/** The object items of a list prop; a page's data may hold anything else, or no list at all. */
export const objectItems = <T>(list: readonly T[] | undefined): T[] =>
  (Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object");

const LABEL_FIELDS = ["label", "text", "title", "name", "header"] as const;

/**
 * Something a page can draw. A model often writes a column or legend entry as `{key, label}`
 * where a node belongs; drawing the object itself is React's "not a valid child" error.
 */
export function show(value: unknown): ReactNode {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (isValidElement(value)) return value;
  if (Array.isArray(value)) return value.map((item) => show(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const field of LABEL_FIELDS) {
      const inner = record[field];
      if (typeof inner === "string" || typeof inner === "number" || isValidElement(inner)) {
        return inner;
      }
    }
  }
  return null;
}

/** The field a column descriptor reads when a row is an object instead of an array of cells. */
export function columnKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || isValidElement(value)) {
    return undefined;
  }
  const key = (value as { key?: unknown }).key;
  return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
}
