export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = true) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
