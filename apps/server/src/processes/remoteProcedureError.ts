import type { ConfigValidationDomainError } from "@mdcz/shared/error";

export class RemoteProcedureError extends Error {
  constructor(
    message: string,
    readonly domainError?: ConfigValidationDomainError,
  ) {
    super(message);
  }
}
