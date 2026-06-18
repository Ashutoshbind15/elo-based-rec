export type Lc0Error = {
  message: string;
  statusCode: number;
};

export function lc0Error(message: string, statusCode = 500): Lc0Error {
  return { message, statusCode };
}

export function badRequest(message: string): Lc0Error {
  return lc0Error(message, 400);
}

export function isLc0Error(error: unknown): error is Lc0Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "message" in error
  );
}

export function toLc0Error(error: unknown): Lc0Error {
  if (isLc0Error(error)) {
    return error;
  }
  return lc0Error(error instanceof Error ? error.message : "Engine request failed");
}
