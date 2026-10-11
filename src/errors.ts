export class SlskdError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: { operationId?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
  }
}

export function unknownOutcome(operationId?: string): SlskdError {
  return new SlskdError(
    'OUTCOME_UNKNOWN',
    'slskd may have accepted this operation. Inspect its ID before deciding whether to repeat the operation; no retry was attempted.',
    operationId ? { operationId } : {},
  );
}

export function errorResult(error: unknown) {
  return error instanceof SlskdError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: 'INTERNAL_ERROR', message: 'Unexpected error while communicating with slskd.' };
}

export function jsonResult<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}
