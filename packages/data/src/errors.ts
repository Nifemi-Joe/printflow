/** Errors the API maps to HTTP responses. Messages are safe to show to users. */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}
export class RuleViolationError extends Error {
  override readonly name = "RuleViolationError";
  constructor(message: string, readonly code: string) {
    super(message);
  }
}
