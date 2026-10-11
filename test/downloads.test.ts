import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSlskdClient } from '../src/client.js';
import { readConfig } from '../src/config.js';
import {
  downloadQueueOutput,
  downloadListOutput,
  downloadStatusOutput,
  transferCompletion,
} from '../src/downloads.js';
import { SlskdError, errorResult } from '../src/errors.js';

const batchId = '550e8400-e29b-41d4-a716-446655440000';
const id = '660e8400-e29b-41d4-a716-446655440000';
const otherId = '770e8400-e29b-41d4-a716-446655440000';
const key = 'private-fixture-key';
const username = ' Péér/#?% 音楽 ';
const filename = 'Music\\Écho\\01 曲.flac';
const envFor = (base: string) => ({
  SLSKD_URL: base,
  SLSKD_API_KEY: key,
});
const clientFor = (base: string) => createSlskdClient(readConfig(envFor(base)));
const transfer = (extra = {}) => ({
  id,
  batchId,
  username,
  direction: 'Download',
  filename,
  size: 100,
  bytesTransferred: 25,
  state: 'InProgress',
  removed: false,
  averageSpeed: 12.5,
  startedAt: '2026-10-11T06:00:00.1234567Z',
  endedAt: null,
  ...extra,
});
const batch = (transfers = [transfer()], extra = {}) => ({
  id: batchId,
  username,
  direction: 'Download',
  transfers,
  ...extra,
});
const queueArgs = () => ({ username, requestId: batchId, files: [{ filename, sizeBytes: 100 }] });
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
  }
  return JSON.parse(text) as Record<string, unknown>;
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
async function withClient(
  env: Record<string, string>,
  run: (client: Client) => Promise<void>,
  args = [fileURLToPath(new URL('../src/index.js', import.meta.url))],
) {
  const client = new Client({ name: 'download-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
  }
}
const names = [
  'download_queue',
  'download_list',
  'download_status',
  'download_cancel',
  'download_clear_completed',
];

test('stdio exposes all fourteen tools without credentials or a download flag', async () => {
  await withClient({}, async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    assert.deepEqual(
      tools.filter((tool) => names.includes(tool.name)).map((tool) => tool.name),
      names,
    );
    const result = await client.callTool({ name: 'download_list', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown>).code, 'AUTH_NOT_CONFIGURED');
  });
});

test('obsolete download flag values do not affect discovery or download calls', async () => {
  await fixture(
    (req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/api/v0/transfers/downloads?includeRemoved=false');
      json(res, []);
    },
    async (base) => {
      for (const value of ['false', 'true', 'TRUE']) {
        await withClient({ ...envFor(base), SLSKD_ENABLE_DOWNLOADS: value }, async (client) => {
          const { tools } = await client.listTools();
          assert.equal(tools.length, 14);
          const result = await client.callTool({ name: 'download_list', arguments: {} });
          assert(!result.isError);
          assert.deepEqual(downloadListOutput.parse(result.structuredContent).items, []);
        });
      }
    },
  );
});

test('enqueue sends only exact requested identities, batch/search IDs and preserves prefix', async () => {
  let calls = 0;
  await fixture(
    async (req, res) => {
      calls++;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/prefix/api/v0/transfers/downloads/batches');
      assert.equal(req.headers['x-api-key'], key);
      assert.deepEqual(await body(req), {
        id: batchId,
        searchId: otherId,
        username,
        files: [{ filename, size: 100 }],
      });
      json(res, { batch: batch(), failures: [] }, 201);
    },
    async (base) => {
      const result = downloadQueueOutput.parse(
        await clientFor(base + '/prefix/').downloadQueue({ ...queueArgs(), searchId: otherId }),
      );
      assert.deepEqual(result.accepted, [{ filename, sizeBytes: 100, transferId: id }]);
      assert.equal(result.outcome, 'accepted');
      assert.equal(result.acceptedCount, 1);
      assert(!('isComplete' in result));
      assert.equal(calls, 1);
    },
  );
});

test('malformed paths, duplicate names, sizes, selectors and unsupported options reject before dispatch', async () => {
  let calls = 0;
  await fixture(
    (_req, res) => {
      calls++;
      res.end();
    },
    async (base) => {
      const slskd = clientFor(base);
      for (const path of ['', '  ', 'a\0b', 'a/../b', 'a\\..\\b', '../b', '..\\b']) {
        await assert.rejects(
          slskd.downloadQueue({ ...queueArgs(), files: [{ filename: path, sizeBytes: 1 }] }),
          { code: 'INVALID_ARGUMENT' },
        );
      }
      for (const sizeBytes of [-1, 1.5, 9007199254740992]) {
        await assert.rejects(
          slskd.downloadQueue({ ...queueArgs(), files: [{ filename, sizeBytes }] }),
          { code: 'INVALID_ARGUMENT' },
        );
      }
      for (const args of [
        { ...queueArgs(), files: [] },
        { ...queueArgs(), files: [queueArgs().files[0], { filename, sizeBytes: 200 }] },
        {
          ...queueArgs(),
          files: Array.from({ length: 101 }, (_, i) => ({ filename: `a${i}`, sizeBytes: 1 })),
        },
        { ...queueArgs(), destination: '/tmp' },
        { ...queueArgs(), username: '..' },
        { ...queueArgs(), username: 'a\0b' },
        { ...queueArgs(), requestId: '00000000-0000-0000-0000-000000000000' },
      ]) {
        await assert.rejects(slskd.downloadQueue(args), { code: 'INVALID_ARGUMENT' });
      }
      for (const args of [
        {},
        { batchId, username, transferId: id },
        { username },
        { username, transferId: id, limit: 1 },
        { batchId, limit: 101 },
      ]) {
        await assert.rejects(slskd.downloadStatus(args), { code: 'INVALID_ARGUMENT' });
      }
      await assert.rejects(slskd.downloadCancel({ username, transferId: id, remove: 'true' }), {
        code: 'INVALID_ARGUMENT',
      });
      await assert.rejects(slskd.downloadClearCompleted({ username }), {
        code: 'INVALID_ARGUMENT',
      });
      await assert.rejects(slskd.downloadQueue(queueArgs(), AbortSignal.abort()), {
        code: 'CANCELLED',
      });
      assert.equal(calls, 0);
    },
  );
});

test('batch counts derive from per-file outcomes, including failure records and absent associations', async () => {
  for (const [status, failedCount] of [
    [201, 0],
    [207, 1],
    [200, 2],
    [201, 2],
  ]) {
    const files = [
      { filename, sizeBytes: 100 },
      { filename: 'Music\\two.flac', sizeBytes: 50 },
    ];
    await fixture(
      (_req, res) =>
        json(
          res,
          {
            batch: batch([transfer()]),
            failures: files
              .slice(0, failedCount)
              .map((file) => ({ filename: file.filename, message: key })),
          },
          status,
        ),
      async (base) => {
        const slskd = clientFor(base);

        const result = await slskd.downloadQueue({ ...queueArgs(), files });
        assert.equal(result.acceptedCount, 2 - failedCount!);
        assert.equal(result.failedCount, failedCount);
        assert.equal(
          result.outcome,
          failedCount === 0 ? 'accepted' : failedCount === 1 ? 'partial' : 'rejected',
        );
        assert(!JSON.stringify(result).includes(key));
        if (failedCount! < 2) {
          assert.equal(result.accepted.at(-1)?.transferId, null);
        }
      },
    );
  }
});

test('untrusted/mismatched successful enqueue bodies become ID-bearing uncertain outcomes', async () => {
  for (const response of [
    {},
    { batch: batch([], { id: otherId }), failures: [] },
    { batch: batch([], { username: 'wrong' }), failures: [] },
    { batch: batch([transfer({ filename: 'other' })]), failures: [] },
    { batch: batch([transfer({ size: 101 })]), failures: [] },
    { batch: batch([transfer({ batchId: otherId })]), failures: [] },
    { batch: batch([transfer(), transfer()]), failures: [] },
    { batch: batch(), failures: [{ filename: 'unexpected', message: key }] },
    { batch: batch(), failures: [{ filename }, { filename }] },
  ]) {
    let calls = 0;
    await fixture(
      (_req, res) => {
        calls++;
        json(res, response, 201);
      },
      async (base) => {
        const slskd = clientFor(base);

        await assert.rejects(slskd.downloadQueue(queueArgs()), (error: unknown) => {
          assert(error instanceof SlskdError);
          assert.equal(error.code, 'OUTCOME_UNKNOWN');
          assert.equal(error.details.operationId, batchId);
          return true;
        });
        assert.equal(calls, 1);
      },
    );
  }
});

test('enqueue never retries lost responses or timeout and can reconcile a generated batch ID', async () => {
  for (const mode of ['disconnect', 'timeout', '500', 'invalid', 'cancel']) {
    let calls = 0;
    let savedId = '';
    const abort = new AbortController();
    await fixture(
      async (req, res) => {
        if (req.method === 'POST') {
          calls++;
          savedId = String((await body(req)).id);
          if (mode === 'disconnect') {
            req.socket.destroy();
          } else if (mode === 'cancel') {
            abort.abort();
          } else if (mode !== 'timeout') {
            res.statusCode = mode === '500' ? 500 : 201;
            res.end(key);
          }
        } else {
          assert.equal(req.url, `/api/v0/transfers/downloads/batches/${savedId}`);
          json(res, batch([transfer({ batchId: savedId })], { id: savedId }));
        }
      },
      async (base) => {
        const slskd = clientFor(base);

        await assert.rejects(
          createSlskdClient(
            readConfig({ ...envFor(base), SLSKD_PEER_TIMEOUT_MS: '100' }),
          ).downloadQueue({ username, files: queueArgs().files }, abort.signal),
          (error: unknown) => {
            assert(error instanceof SlskdError);
            assert.equal(error.code, 'OUTCOME_UNKNOWN');
            assert.equal(error.details.operationId, savedId);
            assert(!JSON.stringify(errorResult(error)).includes(key));
            return true;
          },
        );
        const result = await slskd.downloadStatus({ batchId: savedId });
        assert.equal(result.kind, 'batch');
        assert.equal(calls, 1);
      },
    );
  }
});

test('enqueue known rejections include duplicate ID conflicts and never retry', async () => {
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
        res.writeHead(status, { 'Retry-After': '2' });
        res.end(key);
      },
      async (base) => {
        const slskd = clientFor(base);

        await assert.rejects(slskd.downloadQueue(queueArgs()), (error: unknown) => {
          assert(error instanceof SlskdError);
          assert.equal(error.code, code);
          assert(!error.message.includes(key));
          if (status === 409) {
            assert.equal(error.details.operationId, batchId);
          }
          return true;
        });
        assert.equal(calls, 1);
      },
    );
  }
});

test('transfer state categories distinguish success, failure, progress and unknown future flags', () => {
  assert.deepEqual(transferCompletion('Completed, Succeeded'), {
    isComplete: true,
    isSuccessful: true,
  });
  for (const flag of ['Cancelled', 'TimedOut', 'Errored', 'Rejected', 'Aborted']) {
    assert.deepEqual(transferCompletion(`Completed, ${flag}`), {
      isComplete: true,
      isSuccessful: false,
    });
  }
  assert.deepEqual(transferCompletion('Queued, Remotely'), {
    isComplete: false,
    isSuccessful: false,
  });
  assert.deepEqual(transferCompletion('Completed, FutureState'), {
    isComplete: null,
    isSuccessful: null,
  });
  assert.deepEqual(transferCompletion('Succeeded'), { isComplete: null, isSuccessful: null });
});

test('grouped downloads flatten, filter and page by ID without exposing local paths', async () => {
  await fixture(
    (req, res) => {
      assert.equal(req.method, 'GET');
      assert(req.url?.startsWith('/api/v0/transfers/downloads?includeRemoved='));
      json(res, [
        {
          username,
          directories: [
            {
              files: [
                transfer({ id: otherId, removed: true }),
                transfer({ size: 0, bytesTransferred: 0, localPath: key, exception: key }),
              ],
            },
          ],
        },
      ]);
    },
    async (base) => {
      const slskd = clientFor(base);
      const result = downloadListOutput.parse(await slskd.downloadList({}));
      assert.equal(result.matchedCount, 1);
      assert.equal(result.items[0]?.percentComplete, 0);
      assert.equal(result.items[0]?.averageSpeedBytesPerSecond, 12.5);
      assert(!JSON.stringify(result).includes(key));
      const all = await slskd.downloadList({ includeRemoved: true, limit: 1, offset: 1 });
      assert.equal(all.matchedCount, 2);
      assert.equal(all.items[0]?.transferId, otherId);
      assert.equal(all.items[0]?.removed, true);
      assert.equal((await slskd.downloadList({ username: 'different' })).matchedCount, 0);
      assert.equal((await slskd.downloadList({ states: ['inprogress'] })).matchedCount, 0);
      assert.equal((await slskd.downloadList({ states: ['InProgress'] })).matchedCount, 1);
      assert.deepEqual((await slskd.downloadList({ offset: 100 })).items, []);
    },
  );
});

test('batch status uses full verified associations, includes removed records explicitly, and validates identity', async () => {
  await fixture(
    (req, res) => {
      assert.equal(req.url, `/api/v0/transfers/downloads/batches/${batchId}`);
      json(
        res,
        batch([
          transfer({ id: otherId, removed: true }),
          transfer({ state: 'Completed, FutureFlag' }),
        ]),
      );
    },
    async (base) => {
      const slskd = clientFor(base);

      const result = downloadStatusOutput.parse(await slskd.downloadStatus({ batchId, limit: 1 }));
      assert.equal(result.kind, 'batch');
      assert.equal(result.items?.[0]?.transferId, id);
      assert.equal(result.items?.[0]?.isComplete, null);
      assert.equal(result.hasMore, true);
      const next = downloadStatusOutput.parse(await slskd.downloadStatus({ batchId, offset: 1 }));
      assert.equal(next.items?.[0]?.available, false);
      assert.equal(next.items?.[0]?.transferId, otherId);
    },
  );
  for (const value of [
    batch([], { id: otherId }),
    batch([transfer({ batchId: otherId })]),
    batch([transfer({ username: 'wrong' })]),
    batch([transfer(), transfer()]),
    { ...batch(), transfers: [{ id }] },
  ]) {
    await fixture(
      (_req, res) => json(res, value),
      async (base) => {
        const slskd = clientFor(base);

        await assert.rejects(slskd.downloadStatus({ batchId }), {
          code: 'INVALID_RESPONSE',
        });
      },
    );
  }
});

test('single status and cancel check both username and ID; missing/mismatched identity sends no DELETE', async () => {
  for (const wrong of [{ username: 'foreign' }, { id: otherId }]) {
    const methods: string[] = [];
    await fixture(
      (req, res) => {
        methods.push(req.method!);
        json(res, transfer(wrong));
      },
      async (base) => {
        const slskd = clientFor(base);

        for (const fn of ['downloadStatus', 'downloadCancel'] as const) {
          await assert.rejects(slskd[fn]({ username, transferId: id }), {
            code: 'INVALID_ARGUMENT',
          });
        }
        assert.deepEqual(methods, ['GET', 'GET']);
      },
    );
  }
  await fixture(
    (req, res) => {
      assert.equal(req.method, 'GET');
      res.statusCode = 404;
      res.end(key);
    },
    async (base) => {
      const slskd = clientFor(base);

      await assert.rejects(slskd.downloadCancel({ username, transferId: id }), {
        code: 'NOT_FOUND',
      });
    },
  );
});

test('cancel acknowledges exact selected identity with default remove=false and optional remove=true', async () => {
  for (const remove of [undefined, true]) {
    const methods: string[] = [];
    await fixture(
      (req, res) => {
        methods.push(req.method!);
        const path = `/prefix/api/v0/transfers/downloads/${encodeURIComponent(username)}/${id}`;
        if (req.method === 'GET') {
          assert.equal(req.url, path);
          json(res, transfer());
        } else {
          assert.equal(req.url, `${path}?remove=${remove ?? false}`);
          res.statusCode = 204;
          res.end();
        }
      },
      async (base) => {
        const result = await clientFor(base + '/prefix').downloadCancel({
          username,
          transferId: id,
          ...(remove === undefined ? {} : { remove }),
        });
        assert.deepEqual(result, {
          username,
          transferId: id,
          cancelRequested: true,
          removed: remove ?? false,
        });
        assert.deepEqual(methods, ['GET', 'DELETE']);
      },
    );
  }
});

test('cancel handles preflight races, cancellation and ambiguous DELETE without retry', async () => {
  for (const mode of ['gone', 'disconnect', 'cancel']) {
    let deletes = 0;
    const abort = new AbortController();
    await fixture(
      (req, res) => {
        if (req.method === 'GET') {
          json(res, transfer());
          if (mode === 'cancel') {
            abort.abort();
          }
        } else {
          deletes++;
          if (mode === 'gone') {
            res.statusCode = 404;
            res.end();
          } else {
            req.socket.destroy();
          }
        }
      },
      async (base) => {
        const slskd = clientFor(base);

        await assert.rejects(slskd.downloadCancel({ username, transferId: id }, abort.signal), {
          code: mode === 'gone' ? 'NOT_FOUND' : mode === 'cancel' ? 'CANCELLED' : 'OUTCOME_UNKNOWN',
        });
        assert.equal(deletes, mode === 'cancel' ? 0 : 1);
      },
    );
  }
});

test('cleanup calls global terminal-history endpoint once without claiming counts or file removal', async () => {
  let calls = 0;
  await fixture(
    (req, res) => {
      calls++;
      assert.equal(req.method, 'DELETE');
      assert.equal(req.url, '/api/v0/transfers/downloads/all/completed');
      res.statusCode = 204;
      res.end();
    },
    async (base) => {
      const slskd = clientFor(base);

      assert.deepEqual(await slskd.downloadClearCompleted({}), {
        cleared: true,
        scope: 'all_completed',
      });
      assert.equal(calls, 1);
    },
  );
});

test('real stdio calls all five tools and preserves partial/rejected batch output semantics', async () => {
  let queueMode = 'accepted';
  const requests: string[] = [];
  await fixture(
    async (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST') {
        await body(req);
        json(
          res,
          {
            batch: batch(),
            failures: queueMode !== 'accepted' ? [{ filename, message: key }] : [],
          },
          queueMode === 'rejected' ? 200 : queueMode === 'partial' ? 207 : 201,
        );
      } else if (req.method === 'DELETE') {
        res.statusCode = 204;
        res.end();
      } else if (req.url?.includes('/batches/')) {
        json(res, batch());
      } else if (req.url?.includes('?includeRemoved=')) {
        json(res, [{ username, directories: [{ files: [transfer()] }] }]);
      } else {
        json(res, transfer());
      }
    },
    async (base) => {
      await withClient(envFor(base), async (client) => {
        const { tools } = await client.listTools();
        for (const name of names) {
          assert(tools.find((tool) => tool.name === name)?.outputSchema);
        }
        assert.equal(
          tools.find((tool) => tool.name === 'download_clear_completed')?.annotations
            ?.destructiveHint,
          true,
        );
        for (const [name, args] of [
          ['download_queue', queueArgs()],
          ['download_list', {}],
          ['download_status', { batchId }],
          ['download_status', { username, transferId: id }],
          ['download_cancel', { username, transferId: id }],
          ['download_clear_completed', {}],
        ] as const) {
          const result = await client.callTool({ name, arguments: args });
          assert(!result.isError, JSON.stringify(result.structuredContent));
          const content = result.content as { type: string; text?: string }[];
          assert.deepEqual(JSON.parse(content[0]!.text!), result.structuredContent);
        }
        queueMode = 'partial';
        const partial = await client.callTool({
          name: 'download_queue',
          arguments: {
            ...queueArgs(),
            files: [...queueArgs().files, { filename: 'second.flac', sizeBytes: 50 }],
          },
        });
        assert(!partial.isError);
        assert.equal(downloadQueueOutput.parse(partial.structuredContent).outcome, 'partial');
        queueMode = 'rejected';
        const rejected = await client.callTool({ name: 'download_queue', arguments: queueArgs() });
        assert.equal(rejected.isError, true);
        const data = downloadQueueOutput.parse(rejected.structuredContent);
        assert.equal(data.outcome, 'rejected');
        assert.equal(data.batchId, batchId);
        assert(!JSON.stringify(rejected).includes(key));
        const before = requests.length;
        assert.equal(
          (
            await client.callTool({
              name: 'download_queue',
              arguments: { ...queueArgs(), destination: '/tmp' },
            })
          ).isError,
          true,
        );
        assert.equal(requests.length, before);
        assert(requests.every((request) => request.includes('/transfers/downloads')));
      });
    },
  );
});
