import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSlskdClient } from '../src/client.js';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { MAX_RESPONSE_BYTES } from '../src/http.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function fixture(handler: Handler, run: (base: string) => Promise<void>) {
  const server = httpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  assert(address && typeof address !== 'string');

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

function response(res: ServerResponse, data: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

const key = 'test-secret-must-not-leak';
const envFor = (url: string) => ({ SLSKD_URL: url, SLSKD_API_KEY: key });
const clientFor = (base: string) => createSlskdClient(readConfig(envFor(base)));

test('validates configuration without revealing credentials', () => {
  assert.deepEqual(readConfig({}).headers, { Accept: 'application/json' });
  assert.throws(
    () => readConfig({ ...envFor('http://user:secret@localhost'), SLSKD_TIMEOUT_MS: '1' }),
    { code: 'CONFIG_ERROR' },
  );
  assert.throws(() => readConfig({ ...envFor('http://localhost'), SLSKD_BEARER_TOKEN: key }), {
    code: 'CONFIG_ERROR',
  });
});

test('uses only the two GET endpoints, preserves URL prefix, reports readiness', async () => {
  const requests: string[] = [];

  await fixture(
    (req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers['x-api-key'], key);
      requests.push(req.url!);

      response(
        res,
        req.url?.endsWith('/version')
          ? '0.26.0'
          : { isConnected: true, isLoggedIn: true, state: 'Connected, LoggedIn' },
      );
    },
    async (base) => {
      assert.deepEqual(await clientFor(base + '/slskd/').connectionStatus(), {
        reachable: true,
        authenticated: true,
        version: '0.26.0',
        connected: true,
        loggedIn: true,
        readyToSearch: true,
        state: 'Connected, LoggedIn',
      });

      assert.deepEqual(requests.sort(), [
        '/slskd/api/v0/application/version',
        '/slskd/api/v0/server',
      ]);
    },
  );
});

test('reachable API with disconnected Soulseek is not ready to search', async () => {
  await fixture(
    (req, res) =>
      response(
        res,
        req.url?.endsWith('/version') ? '0.26.0' : { isConnected: false, isLoggedIn: false },
      ),
    async (base) => {
      const slskd = clientFor(base);

      const status = await slskd.connectionStatus();
      assert.equal(status.reachable, true);
      assert.equal(status.readyToSearch, false);
    },
  );
});

test('bearer session authentication works', async () => {
  await fixture(
    (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers['x-api-key'], undefined);

      response(
        res,
        req.url?.endsWith('/version') ? '0.26.0' : { isConnected: true, isLoggedIn: false },
      );
    },
    async (base) => {
      const status = await createSlskdClient(
        readConfig({ SLSKD_URL: base, SLSKD_BEARER_TOKEN: key }),
      ).connectionStatus();
      assert.equal(status.readyToSearch, false);
    },
  );
});

for (const [httpStatus, code] of [
  [400, 'INVALID_ARGUMENT'],
  [409, 'CONFLICT'],
  [429, 'RATE_LIMITED'],
  [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [500, 'HTTP_ERROR'],
] as const) {
  test(`HTTP ${httpStatus} gives ${code} without exposing response body`, async () => {
    await fixture(
      (_req, res) => {
        res.statusCode = httpStatus;
        res.end(key);
      },
      async (base) => {
        const slskd = clientFor(base);

        await assert.rejects(slskd.connectionStatus(), (error: unknown) => {
          assert(error instanceof Error);
          assert(!error.message.includes(key));
          return (error as Error & { code: string }).code === code;
        });
      },
    );
  });
}

test('rejects invalid JSON and unexpected response shapes', async () => {
  for (const payload of ['<html>login</html>', '{}']) {
    await fixture(
      (_req, res) => res.end(payload),
      async (base) => {
        const slskd = clientFor(base);

        await assert.rejects(slskd.connectionStatus(), { code: 'INVALID_RESPONSE' });
      },
    );
  }
});

test('HTTP client deadlines report TIMEOUT before headers and during body reads', async () => {
  for (const partialBody of [false, true]) {
    await fixture(
      (_req, res) => {
        if (partialBody) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{');
        }
      },
      async (base) => {
        const slskd = createSlskdClient(readConfig({ ...envFor(base), SLSKD_TIMEOUT_MS: '100' }));
        await assert.rejects(slskd.connectionStatus(), { code: 'TIMEOUT' });
      },
    );
  }
});

test('both status endpoints use the shared response size limit', async () => {
  for (const endpoint of ['/server', '/application/version']) {
    await fixture(
      (req, res) => {
        if (req.url === `/api/v0${endpoint}`) {
          res.writeHead(200, { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) });
          res.end('x');
        } else {
          response(
            res,
            req.url?.endsWith('/version')
              ? '0.26.0'
              : {
                  isConnected: true,
                  isLoggedIn: true,
                },
          );
        }
      },
      async (base) => {
        await assert.rejects(clientFor(base).connectionStatus(), { code: 'RESPONSE_TOO_LARGE' });
      },
    );
  }
});

test('does not follow redirects carrying credentials', async () => {
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
          const slskd = clientFor(base);

          await assert.rejects(slskd.connectionStatus(), { code: 'UNREACHABLE' });
          assert.equal(reached, false);
        },
      );
    },
  );
});

test('real stdio MCP retains the read-only status contract', async () => {
  await fixture(
    (req, res) =>
      response(
        res,
        req.url?.endsWith('/version') ? '0.26.0' : { isConnected: true, isLoggedIn: true },
      ),
    async (base) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
        env: { SLSKD_URL: base, SLSKD_API_KEY: key },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'test', version: '1.0.0' });

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
        assert.equal(tools[0]?.annotations?.readOnlyHint, true);

        const result = await client.callTool({ name: 'connection_status', arguments: {} });
        assert(!result.isError);
        assert.equal((result.structuredContent as Record<string, unknown>)?.readyToSearch, true);

        const invalid = await client.callTool({
          name: 'connection_status',
          arguments: { url: 'http://example.com' },
        });
        assert.equal(invalid.isError, true);
      } finally {
        await client.close();
      }
    },
  );
});
