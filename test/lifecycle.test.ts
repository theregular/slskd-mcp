import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  searchList,
  searchStop,
  searchDelete,
  searchResults,
  searchListOutput,
} from '../src/search.js';
import { SlskdError, errorResult } from '../src/errors.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const otherId = '660e8400-e29b-41d4-a716-446655440000';
const key = 'private-test-key';
const envFor = (base: string) => ({ SLSKD_URL: base, SLSKD_API_KEY: key });
const record = (extra = {}) => ({ id, searchText: 'Bach [live]', state: 'InProgress', ...extra });
function json(res: ServerResponse, value: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
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

test('list filters literal queries, sorts IDs, projects compact summaries and pages after filtering', async () => {
  await fixture(
    (req, res) => {
      assert.equal(req.url, '/prefix/api/v0/searches');
      assert.equal(req.method, 'GET');
      assert.equal(req.headers['x-api-key'], key);
      json(res, [
        record({ id: otherId, state: 'Completed, FutureFlag', responses: [{ secret: key }] }),
        record({ state: 'Completed, TimedOut', responses: [{ secret: key }] }),
        record({ id: '770e8400-e29b-41d4-a716-446655440000', searchText: 'Other' }),
      ]);
    },
    async (base) => {
      const env = envFor(base + '/prefix');
      const result = await searchList({ queryContains: 'BACH [LIVE]', offset: 1, limit: 1 }, env);
      assert.equal(searchListOutput.safeParse(result).success, true);
      assert.deepEqual(result.items, [
        {
          searchId: otherId,
          query: 'Bach [live]',
          state: 'Completed, FutureFlag',
          isComplete: null,
        },
      ]);
      assert.equal(result.matchedCount, 2);
      assert.equal(result.hasMore, false);
      assert(!JSON.stringify(result).includes(key));
      const first = await searchList({ limit: 1 }, env);
      assert.equal(first.items[0]?.searchId, id);
      assert.equal(first.items[0]?.isComplete, true);
      assert.equal(first.hasMore, true);
      assert.equal((await searchList({ queryContains: '.*' }, env)).matchedCount, 0);
      assert.deepEqual((await searchList({ offset: 100 }, env)).items, []);
    },
  );
});

test('list distinguishes empty collections from malformed JSON and summary shapes', async () => {
  for (const payload of [
    '[]',
    '{}',
    '[{}]',
    JSON.stringify([record({ state: null })]),
    'bad JSON',
  ]) {
    await fixture(
      (_req, res) => {
        res.end(payload);
      },
      async (base) => {
        if (payload === '[]') {
          assert.equal((await searchList({}, envFor(base))).matchedCount, 0);
        } else {
          await assert.rejects(searchList({}, envFor(base)), { code: 'INVALID_RESPONSE' });
        }
      },
    );
  }
});

test('lifecycle inputs and pre-dispatch cancellation never send requests', async () => {
  let requests = 0;
  await fixture(
    (_req, res) => {
      requests++;
      res.end();
    },
    async (base) => {
      const env = envFor(base);
      for (const raw of [{ limit: 101 }, { offset: -1 }, { queryContains: 1 }, { url: base }]) {
        await assert.rejects(searchList(raw, env), { code: 'INVALID_ARGUMENT' });
      }
      for (const fn of [searchStop, searchDelete]) {
        for (const raw of [{ searchId: '../all' }, { searchId: id, all: true }, {}]) {
          await assert.rejects(fn(raw, env), { code: 'INVALID_ARGUMENT' });
        }
        await assert.rejects(fn({ searchId: id }, env, AbortSignal.abort()), { code: 'CANCELLED' });
        await assert.rejects(fn({ searchId: id }, { SLSKD_URL: base }), {
          code: 'AUTH_NOT_CONFIGURED',
        });
      }
      await assert.rejects(searchList({}, env, AbortSignal.abort()), { code: 'CANCELLED' });
      assert.equal(requests, 0);
    },
  );
});

test('stop and delete use exact prefixed paths, no body, and accept empty 200/204', async () => {
  const seen: string[] = [];
  await fixture(
    async (req, res) => {
      assert.equal(req.url, `/prefix/api/v0/searches/${id}`);
      assert.equal(req.headers['x-api-key'], key);
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
      }
      assert.equal(body, '');
      seen.push(req.method!);
      res.statusCode = req.method === 'PUT' ? 200 : 204;
      res.end();
    },
    async (base) => {
      const env = envFor(base + '/prefix/');
      assert.deepEqual(await searchStop({ searchId: id }, env), {
        searchId: id,
        stopRequested: true,
      });
      assert.deepEqual(await searchDelete({ searchId: id }, env), { searchId: id, deleted: true });
      assert.deepEqual(seen, ['PUT', 'DELETE']);
    },
  );
});

test('disappearance after listing yields NOT_FOUND for stop/delete, never a false success', async () => {
  let mutations = 0;
  await fixture(
    (req, res) => {
      if (req.method === 'GET') {
        json(res, [record()]);
      } else {
        mutations++;
        res.statusCode = 404;
        res.end(key);
      }
    },
    async (base) => {
      const env = envFor(base);
      assert.equal((await searchList({}, env)).items[0]?.searchId, id);
      for (const fn of [searchStop, searchDelete]) {
        await assert.rejects(fn({ searchId: id }, env), { code: 'NOT_FOUND' });
      }
      assert.equal(mutations, 2);
    },
  );
});

test('lifecycle writes never retry ambiguous transport failures, cancellation, timeouts or unexpected success statuses', async () => {
  for (const fn of [searchStop, searchDelete]) {
    for (const mode of ['disconnect', 'timeout', 'cancel', '500', '202', 'wrong-success']) {
      let calls = 0;
      const abort = new AbortController();
      await fixture(
        (req, res) => {
          calls++;
          assert.equal(req.url, `/api/v0/searches/${id}`);
          if (mode === 'disconnect') {
            req.socket.destroy();
          } else if (mode === 'cancel') {
            abort.abort();
          } else if (mode !== 'timeout') {
            res.statusCode =
              mode === 'wrong-success' ? (fn === searchStop ? 204 : 200) : Number(mode);
            res.end(key);
          }
        },
        async (base) => {
          await assert.rejects(
            fn({ searchId: id }, { ...envFor(base), SLSKD_TIMEOUT_MS: '100' }, abort.signal),
            (error: unknown) => {
              assert(error instanceof SlskdError);
              assert.equal(error.code, 'OUTCOME_UNKNOWN');
              assert.equal(error.details.operationId, id);
              assert(!JSON.stringify(errorResult(error)).includes(key));
              return true;
            },
          );
          assert.equal(calls, 1);
        },
      );
    }
  }
});

test('definite lifecycle write rejections stay sanitized and are not retried', async () => {
  for (const fn of [searchStop, searchDelete]) {
    for (const [status, code] of [
      [400, 'INVALID_ARGUMENT'],
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [429, 'RATE_LIMITED'],
    ] as const) {
      let calls = 0;
      await fixture(
        (_req, res) => {
          calls++;
          res.writeHead(status, { 'Retry-After': '3' });
          res.end(key);
        },
        async (base) => {
          await assert.rejects(fn({ searchId: id }, envFor(base)), (error: unknown) => {
            assert(error instanceof SlskdError);
            assert.equal(error.code, code);
            assert(!JSON.stringify(errorResult(error)).includes(key));
            if (status === 429) {
              assert.equal(error.details.retryAfterSeconds, 3);
            }
            return true;
          });
          assert.equal(calls, 1);
        },
      );
    }
  }
});

test('real stdio exercises all six tools, preserving stopped results and unrelated searches through deletion', async () => {
  let ownId = id;
  let exists = false;
  let state = 'InProgress';
  const mutations: string[] = [];
  const responses = [{ username: 'source', files: [{ filename: 'Album\\Track.flac', size: 123 }] }];
  await fixture(
    async (req, res) => {
      const own = () => record({ id: ownId, state, responses });
      if (req.url === '/api/v0/server') {
        json(res, { isConnected: true, isLoggedIn: true, state: 'Connected, LoggedIn' });
      } else if (req.url === '/api/v0/application/version') {
        json(res, '0.26.0.0');
      } else if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += String(chunk);
        }
        ownId = (JSON.parse(raw) as { id: string }).id;
        exists = true;
        json(res, own());
      } else if (req.url === '/api/v0/searches') {
        json(res, [record({ id: otherId }), ...(exists ? [own()] : [])]);
      } else if (req.url?.split('?')[0] === `/api/v0/searches/${ownId}` && exists) {
        if (req.method === 'GET') {
          json(res, own());
        } else if (req.method === 'PUT') {
          mutations.push(`PUT ${ownId}`);
          state = 'Completed, Cancelled';
          res.end();
        } else if (req.method === 'DELETE') {
          mutations.push(`DELETE ${ownId}`);
          exists = false;
          res.statusCode = 204;
          res.end();
        }
      } else {
        res.statusCode = 404;
        res.end(key);
      }
    },
    async (base) => {
      const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
        env: envFor(base),
        stderr: 'pipe',
      });
      const call = async (name: string, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        assert(!result.isError, JSON.stringify(result.structuredContent));
        const content = result.content as { type: string; text?: string }[];
        assert.deepEqual(JSON.parse(content[0]!.text!), result.structuredContent);
        return result.structuredContent as Record<string, unknown>;
      };
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assert.deepEqual(
          tools.map((tool) => tool.name),
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
        for (const name of ['search_list', 'search_stop', 'search_delete']) {
          assert(tools.find((tool) => tool.name === name)?.outputSchema);
        }
        assert.equal(
          tools.find((tool) => tool.name === 'search_delete')?.annotations?.destructiveHint,
          true,
        );
        assert.equal(
          tools.find((tool) => tool.name === 'search_list')?.annotations?.readOnlyHint,
          true,
        );
        await call('connection_status');
        await call('search_start', { query: 'Bach [live]' });
        const listed = searchListOutput.parse(
          await call('search_list', { queryContains: '[LIVE]' }),
        );
        assert(listed.items.some((item) => item.searchId === ownId));
        const before = await call('search_results', { searchId: ownId });
        assert.deepEqual(await call('search_stop', { searchId: ownId }), {
          searchId: ownId,
          stopRequested: true,
        });
        assert.deepEqual(await call('search_stop', { searchId: ownId }), {
          searchId: ownId,
          stopRequested: true,
        });
        const after = await call('search_results', { searchId: ownId });
        assert.deepEqual(after.items, before.items);
        assert.equal(after.isComplete, true);
        const invalid = await client.callTool({
          name: 'search_delete',
          arguments: { searchId: ownId, all: true },
        });
        assert.equal(invalid.isError, true);
        assert.equal(mutations.length, 2);
        assert.deepEqual(await call('search_delete', { searchId: ownId }), {
          searchId: ownId,
          deleted: true,
        });
        for (const name of ['search_results', 'search_stop', 'search_delete']) {
          const missing = await client.callTool({ name, arguments: { searchId: ownId } });
          assert.equal(missing.isError, true);
          assert.equal((missing.structuredContent as Record<string, unknown>).code, 'NOT_FOUND');
          assert(!JSON.stringify(missing).includes(key));
        }
        const remaining = searchListOutput.parse(await call('search_list'));
        assert.deepEqual(
          remaining.items.map((item) => item.searchId),
          [otherId],
        );
        assert.deepEqual(mutations, [`PUT ${ownId}`, `PUT ${ownId}`, `DELETE ${ownId}`]);
        await assert.rejects(searchResults({ searchId: ownId }, envFor(base)), {
          code: 'NOT_FOUND',
        });
      } finally {
        await client.close();
      }
    },
  );
});
