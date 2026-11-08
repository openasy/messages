// The errors the API answers with, as RFC 9457 Problem Details (ADR 0024).

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "invalid-signature"
  | "not-found"
  | "conflict"
  | "not-configured"
  | "payload-too-large"
  | "upstream-error"
  | "internal-error";

export class MsgError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export const bad = (detail: string) => new MsgError(422, "invalid-body", detail);
export const notFound = (what: string) => new MsgError(404, "not-found", `${what} does not exist.`);
export const conflict = (detail: string) => new MsgError(409, "conflict", detail);
export function fail(detail: string): never {
  throw bad(detail);
}

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const DAY = 86_400_000;
