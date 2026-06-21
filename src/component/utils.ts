import { parse } from "convex-helpers/validators";
import type { Infer, Validator } from "convex/values";

export const assertExhaustive = (value: never): never => {
  throw new Error(`Unhandled case: ${value as string}`);
};

/**
 * Attempt to parse an unknown value against a validator, with TypeScript type
 * narrowing. Strips out anything not declared by the validator.
 */
export function attemptToParse<T extends Validator<any, any, any>>(
  validator: T,
  value: unknown,
): { kind: "success"; data: Infer<T> } | { kind: "error"; error: unknown } {
  try {
    return { kind: "success", data: parse(validator, value) };
  } catch (error) {
    return { kind: "error", error };
  }
}

/** Pull a string field from an unknown object, if present. */
export function pickString(
  obj: unknown,
  ...keys: string[]
): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
