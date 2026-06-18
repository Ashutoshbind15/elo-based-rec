import { err, ok, type Result } from "neverthrow";
import type { ZodType } from "zod";
import { badRequest, type Lc0Error } from "./errors.js";

export function parseSchema<T>(schema: ZodType<T>, data: unknown): Result<T, Lc0Error> {
  const parsed = schema.safeParse(data);

  if (parsed.success) {
    return ok(parsed.data);
  }

  const message = parsed.error.issues.map((issue) => issue.message).join("; ") || "Invalid request";
  return err(badRequest(message));
}
