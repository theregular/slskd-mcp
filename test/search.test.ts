import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import {
  searchStart,
  searchResults,
  searchCompletion,
  searchResultsOutput,
} from '../src/search.js';
import { requestJson, MAX_RESPONSE_BYTES } from '../src/client.js';
import { readConfig } from '../src/config.js';
import { SlskdError, errorResult } from '../src/errors.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const key = 'test-key-never-echo';
const envFor = (base: string) => ({ SLSKD_URL: base, SLSKD_API_KEY: key });
const file = (filename = 'Music\\Album\\01 Écho.flac', extra = {}) => ({
  filename,
  size: 12345,
  extension: '',
  sampleRate: 44100,
  bitDepth: 16,
  ...extra,
});
const peer = (username: string, files = [file()], extra = {}) => ({
  username,
  files,
  hasFreeUploadSlot: true,
  queueLength: 0,
  uploadSpeed: 102400,
  ...extra,
});
const search = (extra = {}) => ({
  id,
  searchText: 'Artist Track',
  state: 'InProgress',
  responses: [],
  ...extra,
});
function json(res: ServerResponse, body: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}
async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  run: (base: string) => Promise<void>,
) {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('search starts once with milliseconds, prefix/auth and generated ID; later reads receive new results', async () => {
  let submitted: Record<string, unknown> = {};
  let posts = 0;
  let reads = 0;
  await fixture(
    async (req, res) => {
      assert.equal(req.headers['x-api-key'], key);
      if (req.method === 'POST') {
        posts++;
        assert.equal(req.url, '/prefix/api/v0/searches');
        submitted = await body(req);
        json(res, { ...search(), id: submitted.id, state: 'Requested' });
      } else {
        reads++;
        assert.equal(
          req.url,
          `/prefix/api/v0/searches/${String(submitted.id)}?includeResponses=true`,
        );
        json(res, {
          ...search(),
          id: submitted.id,
          responses: reads === 1 ? [] : [peer('source')],
        });
      }
    },
    async (base) => {
      const env = envFor(base + '/prefix/');
      const started = await searchStart({ query: ' Artist Track ' }, env);
      assert.equal(started.isComplete, false);
      assert.equal(started.searchTimeoutSeconds, 15);
      assert.deepEqual(submitted, {
        id: started.searchId,
        searchText: 'Artist Track',
        searchTimeout: 15000,
        fileLimit: 10000,
        responseLimit: 100,
      });
      assert.equal((await searchResults({ searchId: started.searchId }, env)).matchedCount, 0);
      const result = await searchResults({ searchId: started.searchId }, env);
      assert.equal(result.matchedCount, 1);
      assert.equal(result.items[0]?.sampleRateHz, 44100);
      assert.equal(result.items[0]?.freeUploadSlots, true);
      assert.equal(result.items[0]?.extension, 'flac');
      assert.equal(result.items[0]?.bitRateKbps, null);
      assert.equal(result.items[0]?.filename, 'Music\\Album\\01 Écho.flac');
      assert.equal(posts, 1);
    },
  );
});

test('validates strict inputs and credentials before any network operation', async () => {
  let calls = 0;
  await fixture(
    (_req, res) => {
      calls++;
      json(res, {});
    },
    async (base) => {
      for (const args of [
        { query: ' ' },
        { query: 'x', fileLimit: 0 },
        { query: 'x', searchTimeoutSeconds: 121 },
        { query: 'x', responseLimit: 1001 },
        { query: 'x', url: base },
        { query: 'a'.repeat(501) },
      ]) {
        await assert.rejects(searchStart(args, envFor(base)), { code: 'INVALID_ARGUMENT' });
      }
      for (const args of [
        { searchId: '../server' },
        { searchId: id, limit: 101 },
        { searchId: id, offset: -1 },
        { searchId: id, filters: { regex: 'x' } },
        { searchId: id, filters: { minBitRateKbps: -1 } },
      ]) {
        await assert.rejects(searchResults(args, envFor(base)), { code: 'INVALID_ARGUMENT' });
      }
      await assert.rejects(searchStart({ query: 'x' }, { SLSKD_URL: base }), {
        code: 'AUTH_NOT_CONFIGURED',
      });
      assert.equal(calls, 0);
    },
  );
});

test('distinguishes empty running, terminal, unknown future states and missing ID', async () => {
  for (const [state, expected] of [
    ['Requested', false],
    ['Queued', false],
    ['Completed, TimedOut', true],
    ['Completed, Errored', true],
    ['Completed, FutureFlag', null],
  ] as const) {
    await fixture(
      (_req, res) => json(res, search({ state })),
      async (base) => {
        const result = await searchResults({ searchId: id }, envFor(base));
        assert.equal(result.isComplete, expected);
        assert.deepEqual(result.items, []);
      },
    );
  }
  assert.equal(searchCompletion('InProgress, Requested'), false);
  await fixture(
    (_req, res) => {
      res.statusCode = 404;
      res.end(key);
    },
    async (base) => {
      await assert.rejects(searchResults({ searchId: id }, envFor(base)), { code: 'NOT_FOUND' });
    },
  );
});

test('filters combine literal include/exclude/extension/bitrate and preserve different sources', async () => {
  const track = file('A\\Artist [live] Track.MP3', { bitRate: 320, extension: '.MP3' });
  const responses = [
    peer('b', [track, track, file('A\\Artist [live] remix.MP3', { bitRate: 320 })]),
    peer('a', [track, file('A\\Artist [live] unknown.mp3')]),
    peer('c', [file('A\\Artist other.mp3', { bitRate: 128 })]),
  ];
  await fixture(
    (_req, res) => json(res, search({ responses })),
    async (base) => {
      const result = await searchResults(
        {
          searchId: id,
          filters: {
            extensions: ['.mp3'],
            minBitRateKbps: 320,
            include: ['ARTIST', '[live]'],
            exclude: ['REMIX'],
          },
          sort: 'bitrate',
        },
        envFor(base),
      );
      assert.equal(result.receivedFileCount, 6);
      assert.equal(result.matchedCount, 2);
      assert.deepEqual(
        result.items.map((f) => f.username),
        ['a', 'b'],
      );
      assert.equal(searchResultsOutput.safeParse(result).success, true);
      const empty = await searchResults(
        { searchId: id, filters: { include: ['.*'] } },
        envFor(base),
      );
      assert.equal(empty.matchedCount, 0);
      const all = await searchResults(
        { searchId: id, filters: { extensions: [], include: [], exclude: [] } },
        envFor(base),
      );
      assert.equal(all.matchedCount, 5);
    },
  );
});

test('sorts availability, bitrate nulls and filename with exact deterministic tie breaks', async () => {
  const responses = [
    peer('unknown', [file('C')], { hasFreeUploadSlot: null, queueLength: null, uploadSpeed: null }),
    peer('busy', [file('B', { bitRate: 320 })], { hasFreeUploadSlot: false, uploadSpeed: 999999 }),
    peer('slow', [file('Z', { bitRate: 128 })], { uploadSpeed: 100 }),
    peer('fast', [file('Y', { bitRate: 0 })], { uploadSpeed: 200 }),
    peer('queued', [file('A', { bitRate: null })], { queueLength: 1, uploadSpeed: 1000 }),
  ];
  await fixture(
    (_req, res) => json(res, search({ responses })),
    async (base) => {
      const env = envFor(base);
      assert.deepEqual(
        (await searchResults({ searchId: id }, env)).items.map((f) => f.username),
        ['fast', 'slow', 'queued', 'busy', 'unknown'],
      );
      assert.deepEqual(
        (await searchResults({ searchId: id, sort: 'bitrate' }, env)).items.map((f) => f.username),
        ['busy', 'slow', 'fast', 'queued', 'unknown'],
      );
      assert.deepEqual(
        (await searchResults({ searchId: id, sort: 'filename' }, env)).items.map((f) => f.filename),
        ['A', 'B', 'C', 'Y', 'Z'],
      );
    },
  );
});

test('deduplicates first identity only and pages after filtering, omitting locked files', async () => {
  const files = Array.from({ length: 30 }, (_, i) =>
    file(`Track ${String(i).padStart(2, '0')}.flac`),
  );
  await fixture(
    (_req, res) =>
      json(
        res,
        search({
          responses: [
            peer(
              'p',
              [
                ...files,
                file(files[0]!.filename, { bitRate: 999 }),
                file('locked', { isLocked: true }),
              ],
              { lockedFiles: [file('private')] },
            ),
          ],
        }),
      ),
    async (base) => {
      const result = await searchResults(
        { searchId: id, sort: 'filename', offset: 25, limit: 3 },
        envFor(base),
      );
      assert.equal(result.items.length, 3);
      assert.equal(result.items[0]?.filename, 'Track 25.flac');
      assert.equal(result.matchedCount, 30);
      assert.equal(result.receivedFileCount, 32);
      assert.equal(result.hasMore, true);
      assert.equal(result.consistency, 'live');
      assert.equal(
        (await searchResults({ searchId: id, offset: 100 }, envFor(base))).hasMore,
        false,
      );
      assert.deepEqual(
        (await searchResults({ searchId: id, offset: 100 }, envFor(base))).items,
        [],
      );
      assert.equal(
        (await searchResults({ searchId: id, sort: 'filename' }, envFor(base))).items[0]
          ?.bitRateKbps,
        null,
      );
    },
  );
});

test('rejects invalid JSON, schema, unsafe file sizes, negative metadata and wrong identity', async () => {
  for (const payload of [
    'not JSON',
    JSON.stringify(search({ responses: null })),
    JSON.stringify(search({ id: '660e8400-e29b-41d4-a716-446655440000' })),
    JSON.stringify(search({ responses: [peer('p', [file('f', { size: 9007199254740992 })])] })),
    JSON.stringify(search({ responses: [peer('p', [file('f', { bitRate: -1 })])] })),
  ]) {
    await fixture(
      (_req, res) => {
        res.end(payload);
      },
      async (base) => {
        await assert.rejects(searchResults({ searchId: id }, envFor(base)), {
          code: 'INVALID_RESPONSE',
        });
      },
    );
  }
});

for (const [status, code] of [
  [400, 'INVALID_ARGUMENT'],
  [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [429, 'RATE_LIMITED'],
  [500, 'HTTP_ERROR'],
] as const) {
  test(`search HTTP ${status} is sanitized as ${code}`, async () => {
    await fixture(
      (_req, res) => {
        res.statusCode = status;
        res.setHeader('Retry-After', '2');
        res.end(key);
      },
      async (base) => {
        await assert.rejects(searchResults({ searchId: id }, envFor(base)), (error: unknown) => {
          assert(error instanceof SlskdError);
          assert.equal(error.code, code);
          assert(!JSON.stringify(errorResult(error)).includes(key));
          if (status === 429) {
            assert.equal(error.details.retryAfterSeconds, 2);
          }
          return true;
        });
      },
    );
  });
}

test('reads time out through body consumption and honor caller cancellation', async () => {
  await fixture(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    },
    async (base) => {
      await assert.rejects(
        searchResults({ searchId: id }, { ...envFor(base), SLSKD_TIMEOUT_MS: '100' }),
        { code: 'TIMEOUT' },
      );
      const abort = new AbortController();
      const pending = searchResults({ searchId: id }, envFor(base), abort.signal);
      abort.abort();
      await assert.rejects(pending, { code: 'CANCELLED' });
    },
  );
});

test('cancelled before dispatch sends nothing, including writes', async () => {
  let calls = 0;
  await fixture(
    (_req, res) => {
      calls++;
      json(res, {});
    },
    async (base) => {
      const signal = AbortSignal.abort();
      await assert.rejects(searchStart({ query: 'track' }, envFor(base), signal), {
        code: 'CANCELLED',
      });
      assert.equal(calls, 0);
    },
  );
});

test('response limits cover both Content-Length and a chunked body without it', async () => {
  for (const advertised of [true, false]) {
    await fixture(
      async (_req, res) => {
        if (advertised) {
          res.writeHead(200, { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) });
          res.end('x');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const chunk = Buffer.alloc(1024 * 1024, 32);
          for (let i = 0; i < 33; i++) {
            if (!res.write(chunk)) {
              await once(res, 'drain');
            }
          }
          res.end();
        }
      },
      async (base) => {
        await assert.rejects(searchResults({ searchId: id }, envFor(base)), {
          code: 'RESPONSE_TOO_LARGE',
        });
      },
    );
  }
});

test('writes never retry after lost response, timeout, malformed success or server failure', async () => {
  for (const mode of ['disconnect', 'timeout', 'invalid', 'shape', 'wrong-id', '500']) {
    let calls = 0;
    let submitted: Record<string, unknown> = {};
    await fixture(
      async (req, res) => {
        calls++;
        submitted = await body(req);
        if (mode === 'disconnect') {
          req.socket.destroy();
        } else if (mode === 'timeout') {
          res.writeHead(200);
          res.write('{');
        } else if (mode === 'invalid') {
          res.end('bad json');
        } else if (mode === 'shape') {
          json(res, {});
        } else if (mode === 'wrong-id') {
          json(res, search());
        } else {
          res.statusCode = 500;
          res.end(key);
        }
      },
      async (base) => {
        await assert.rejects(
          searchStart({ query: 'track' }, { ...envFor(base), SLSKD_TIMEOUT_MS: '100' }),
          (error: unknown) => {
            assert(error instanceof SlskdError);
            assert.equal(error.code, 'OUTCOME_UNKNOWN');
            assert.equal(error.details.operationId, submitted.id);
            assert(!error.message.includes(key));
            return true;
          },
        );
        assert.equal(calls, 1);
      },
    );
  }
});

test('known write rejections stay definite; redirects never carry credentials to another target', async () => {
  for (const [status, code] of [
    [400, 'INVALID_ARGUMENT'],
    [401, 'UNAUTHORIZED'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
  ] as const) {
    let calls = 0;
    await fixture(
      (_req, res) => {
        calls++;
        res.statusCode = status;
        res.end(key);
      },
      async (base) => {
        await assert.rejects(searchStart({ query: 'track' }, envFor(base)), { code });
        assert.equal(calls, 1);
      },
    );
  }
  let reached = false;
  await fixture(
    (_req, res) => {
      reached = true;
      res.end('{}');
    },
    async (target) => {
      await fixture(
        (_req, res) => {
          res.writeHead(302, { Location: target });
          res.end();
        },
        async (base) => {
          await assert.rejects(searchResults({ searchId: id }, envFor(base)), {
            code: 'UNREACHABLE',
          });
          await assert.rejects(searchStart({ query: 'track' }, envFor(base)), {
            code: 'OUTCOME_UNKNOWN',
          });
          assert.equal(reached, false);
        },
      );
    },
  );
});

test('new client preserves bearer authentication and ignores malformed retry hints', async () => {
  await fixture(
    (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers['x-api-key'], undefined);
      res.writeHead(429, { 'Retry-After': key });
      res.end(key);
    },
    async (base) => {
      await assert.rejects(
        requestJson(readConfig({ SLSKD_URL: base, SLSKD_BEARER_TOKEN: key }), '/searches'),
        (error: unknown) => {
          assert(error instanceof SlskdError);
          assert.deepEqual(error.details, {});
          return true;
        },
      );
    },
  );
});

test('real stdio discovers schemas and performs search, read, validation and sanitized error exchanges', async () => {
  let searchId = id;
  let requests = 0;
  await fixture(
    async (req, res) => {
      requests++;
      if (req.method === 'POST') {
        searchId = String((await body(req)).id);
        json(res, search({ id: searchId }));
      } else if (req.url?.includes(searchId)) {
        json(res, search({ id: searchId, responses: [peer('source')] }));
      } else {
        res.statusCode = 404;
        res.end(key);
      }
    },
    async (base) => {
      const client = new Client({ name: 'search-test', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
        env: envFor(base),
        stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assert.deepEqual(
          tools.map((t) => t.name),
          [
            'connection_status',
            'search_start',
            'search_results',
            'search_list',
            'search_stop',
            'search_delete',
            'browse_user',
            'browse_directory',
            'user_info',
            'download_queue',
            'download_list',
            'download_status',
            'download_cancel',
            'download_clear_completed',
          ],
        );
        assert.equal(tools[1]?.annotations?.readOnlyHint, false);
        assert.equal(tools[2]?.annotations?.readOnlyHint, true);
        assert(tools[1]?.outputSchema);
        assert(tools[2]?.outputSchema);
        const started = await client.callTool({
          name: 'search_start',
          arguments: { query: 'Artist Track' },
        });
        assert(!started.isError);
        assert.equal((started.structuredContent as Record<string, unknown>)?.searchId, searchId);
        const result = await client.callTool({ name: 'search_results', arguments: { searchId } });
        assert(!result.isError);
        assert.equal((result.structuredContent as Record<string, unknown>)?.matchedCount, 1);
        const content = result.content as { type: string; text?: string }[];
        assert.deepEqual(JSON.parse(content[0]!.text!), result.structuredContent);
        const invalid = await client.callTool({
          name: 'search_results',
          arguments: { searchId, url: 'http://example.com' },
        });
        assert.equal(invalid.isError, true);
        assert.equal(requests, 2);
        const missing = await client.callTool({
          name: 'search_results',
          arguments: { searchId: id },
        });
        assert.equal(missing.isError, true);
        assert.equal((missing.structuredContent as Record<string, unknown>)?.code, 'NOT_FOUND');
        assert(!JSON.stringify(missing).includes(key));
      } finally {
        await client.close();
      }
    },
  );
});
