import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { createSlskdClient } from '../src/client.js';

const id = '550e8400-e29b-41d4-a716-446655440000';

test('clients use independent configurations without retaining the input environment', async (t) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const prefix = req.url?.startsWith('/first/') ? 'first' : 'second';
    assert.equal(req.headers['x-api-key'], `${prefix}-fixture-key`);
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === `/${prefix}/api/v0/searches`) {
      res.end(JSON.stringify([{ id, searchText: prefix, state: 'Completed' }]));
    } else if (req.url === `/${prefix}/api/v0/server`) {
      res.end(JSON.stringify({ isConnected: true, isLoggedIn: true }));
    } else {
      assert.equal(req.url, `/${prefix}/api/v0/application/version`);
      res.end(JSON.stringify(prefix));
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const env = { SLSKD_URL: `${base}/first/`, SLSKD_API_KEY: 'first-fixture-key' };
  const first = createSlskdClient(readConfig(env));

  env.SLSKD_URL = 'http://127.0.0.1:1';
  env.SLSKD_API_KEY = 'changed-environment';
  const second = createSlskdClient(
    readConfig({ SLSKD_URL: `${base}/second`, SLSKD_API_KEY: 'second-fixture-key' }),
  );

  // Detached methods keep their configured client without requiring a bound `this`.
  const { searchList } = first;
  const [firstList, secondList, firstStatus, secondStatus] = await Promise.all([
    searchList({}),
    second.searchList({}),
    first.connectionStatus(),
    second.connectionStatus(),
  ]);
  assert.equal(firstList.items[0]?.query, 'first');
  assert.equal(secondList.items[0]?.query, 'second');
  assert.equal(firstStatus.version, 'first');
  assert.equal(secondStatus.version, 'second');
  assert.equal(requests.length, 6);
});

test('clients without credentials reject status, searches, peer requests and downloads before HTTP dispatch', async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const slskd = createSlskdClient(readConfig({ SLSKD_URL: `http://127.0.0.1:${address.port}` }));

  await assert.rejects(slskd.connectionStatus(), { code: 'AUTH_NOT_CONFIGURED' });
  await assert.rejects(slskd.searchStart({ query: 'fixture' }), { code: 'AUTH_NOT_CONFIGURED' });
  await assert.rejects(slskd.browseUser({ username: 'fixture' }), { code: 'AUTH_NOT_CONFIGURED' });
  await assert.rejects(slskd.downloadList({}), { code: 'AUTH_NOT_CONFIGURED' });
  await assert.rejects(
    slskd.downloadQueue({
      username: 'fixture',
      files: [{ filename: 'Music/fixture.flac', sizeBytes: 1 }],
    }),
    { code: 'AUTH_NOT_CONFIGURED' },
  );
  assert.equal(requests, 0);
});

test('malformed startup configuration exits with sanitized diagnostics and no protocol output', async () => {
  for (const overrides of [
    { SLSKD_URL: 'http://private-fixture-user:private-fixture-password@localhost' },
    { SLSKD_TIMEOUT_MS: '0' },
    { SLSKD_PEER_TIMEOUT_MS: '0' },
    { SLSKD_BEARER_TOKEN: 'private-fixture-token' },
  ]) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/index.js', import.meta.url))],
      {
        env: { SLSKD_API_KEY: 'private-fixture-key', ...overrides },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'close');

    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Unable to start slskd-mcp: CONFIG_ERROR:/);
    assert(!stderr.includes('private-fixture'));
  }
});
