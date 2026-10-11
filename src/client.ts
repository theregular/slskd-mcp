import { type readConfig } from './config.js';
import { SlskdError, unknownOutcome } from './errors.js';

export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  emptyResponseStatus?: 200 | 204;
  // Some slskd lookups use POST without mutating searches or transfers.
  readOnly?: boolean;
  body?: unknown;
  signal?: AbortSignal;
  operationId?: string;
  legacyStatus?: boolean;
};

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SlskdError('RESPONSE_TOO_LARGE', 'slskd response exceeded 32 MiB.');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new SlskdError('INVALID_RESPONSE', 'slskd returned an empty response body.');
  }

  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SlskdError('RESPONSE_TOO_LARGE', 'slskd response exceeded 32 MiB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
}

export async function requestJson(
  config: ReturnType<typeof readConfig>,
  path: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const method = options.method ?? 'GET';
  const mutates = method !== 'GET' && !options.readOnly;
  const deadline = AbortSignal.timeout(config.timeout);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const timeoutError = () =>
    new SlskdError(
      !options.legacyStatus && options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT',
      !options.legacyStatus && options.signal?.aborted
        ? 'The request was cancelled.'
        : 'slskd did not finish its response before the request timeout.',
    );

  if (signal.aborted) {
    throw timeoutError();
  }

  // Construct the body before dispatch: serialization failures cannot imply a submitted write.
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  let response: Response;
  try {
    response = await fetch(`${config.base}/api/v0${path}`, {
      method,
      headers: { ...config.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body,
      signal,
      redirect: 'error',
    });
  } catch {
    if (mutates) {
      throw unknownOutcome(options.operationId);
    }
    if (signal.aborted) {
      throw timeoutError();
    }
    throw new SlskdError(
      'UNREACHABLE',
      'Cannot reach slskd. Check that it is running and SLSKD_URL is correct. Redirects are not followed.',
    );
  }

  if (!response.ok) {
    // Never read or echo upstream error bodies, including their potentially private text.
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) {
      throw new SlskdError(
        'UNAUTHORIZED',
        'slskd rejected the credentials. Check the API key or renew the temporary session token.',
      );
    }
    if (response.status === 403) {
      throw new SlskdError(
        'FORBIDDEN',
        'slskd denied this request. Check the credential permissions, allowed IPs, and server mode.',
      );
    }
    if (response.status === 404) {
      throw new SlskdError(
        'NOT_FOUND',
        options.legacyStatus
          ? 'slskd API endpoint not found. Use its base URL, including any URL prefix, but omit /api/v0.'
          : 'The requested slskd resource or API endpoint is unavailable.',
      );
    }
    if (!options.legacyStatus) {
      if (response.status === 400) {
        throw new SlskdError('INVALID_ARGUMENT', 'slskd rejected the request arguments.');
      }
      if (response.status === 409) {
        throw new SlskdError(
          'CONFLICT',
          'slskd could not perform this operation in its current state.',
          options.operationId ? { operationId: options.operationId } : {},
        );
      }
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
        throw new SlskdError(
          'RATE_LIMITED',
          'slskd is limiting requests. No retry was attempted.',
          Number.isSafeInteger(seconds) ? { retryAfterSeconds: seconds } : {},
        );
      }
    }
    if (mutates && (response.status >= 500 || response.status === 408)) {
      throw unknownOutcome(options.operationId);
    }
    throw new SlskdError('HTTP_ERROR', `slskd returned HTTP ${response.status}.`);
  }

  if (options.emptyResponseStatus !== undefined) {
    await response.body?.cancel().catch(() => {});
    if (response.status !== options.emptyResponseStatus) {
      throw unknownOutcome(options.operationId);
    }
    return undefined;
  }

  try {
    return options.legacyStatus ? await response.json() : await boundedJson(response);
  } catch (error) {
    if (mutates) {
      throw unknownOutcome(options.operationId);
    }
    if (signal.aborted) {
      throw timeoutError();
    }
    if (error instanceof SlskdError) {
      throw error;
    }
    throw new SlskdError(
      'INVALID_RESPONSE',
      'slskd returned invalid JSON. Check the URL and server version.',
    );
  }
}
