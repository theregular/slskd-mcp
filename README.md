# slskd-mcp

A TypeScript MCP server for slskd. First milestone: one `connection_status` tool.

It reads `GET /api/v0/server` and `GET /api/v0/application/version`. It reports API reachability/authentication, slskd version, Soulseek connection/login status, and readiness to search. A reachable dashboard alone does not mean Soulseek is logged in.

It does not start slskd, search, browse, download, change settings, or register itself in Codex.

## Setup

Use Node.js 22.13+ or 24+ (Node 24 recommended) and pnpm. Dependencies are pinned in `pnpm-lock.yaml`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

Set `SLSKD_API_KEY` in `.env` to an API key configured in your own slskd. For a temporary test, you can use `SLSKD_BEARER_TOKEN` from a dashboard session instead. Set only one credential. No credentials are included or automatically collected by this project. A bearer token expires; use a dedicated API key for eventual persistent registration.

`SLSKD_URL` defaults to `http://127.0.0.1:5030`; omit `/api/v0`. `SLSKD_TIMEOUT_MS` defaults to 5000. Configuration errors are returned as tool errors, so missing credentials do not prevent MCP initialization.

## Run a single MCP test

Start slskd separately, then run:

```sh
pnpm check:connection
```

This builds the project, launches the MCP server as a child process, performs MCP initialization, lists tools, calls `connection_status`, prints the result, and closes the child process. It does not require Codex registration.

Example result:

```json
{
  "reachable": true,
  "authenticated": true,
  "version": "0.26.0",
  "connected": true,
  "loggedIn": true,
  "readyToSearch": true,
  "state": "Connected, LoggedIn"
}
```

A disconnected Soulseek session returns a successful status result with `readyToSearch: false`. Configuration, authentication, network, timeout and response-format failures return MCP `isError: true` and a concise error code. Raw HTTP error bodies are never returned. Redirects are not followed.

## Development

```sh
pnpm test
pnpm build
pnpm start
```

`pnpm start` runs the stdio server and waits for MCP protocol messages; it is not an interactive prompt. Server stdout is reserved for MCP. The human-readable test output comes from the separate smoke-test client.

Tests use local fake HTTP services plus a real MCP stdio exchange. No account credentials or external Soulseek traffic are needed to run them.

## Linting and formatting

ESLint uses the recommended JavaScript and TypeScript rules, requires braces for control flow and consistent type imports, and rejects stdout console logging in server code. Prettier handles layout separately, with two-space indentation, single quotes, semicolons, trailing commas, and a 100-column target. `eslint-config-prettier` prevents conflicting formatting rules.

```sh
pnpm lint          # Check code quality
pnpm lint:fix      # Apply safe automatic lint fixes
pnpm format        # Format source, tests, config, and documentation
pnpm format:check  # Check formatting without changing files
pnpm typecheck     # Check TypeScript without writing dist
pnpm check         # Lint + formatting check + build + tests
```

Generated output, dependencies, and local environment files are excluded. Enable your editor's Prettier formatter to use the committed configuration; `.editorconfig` supplies the basic whitespace defaults. No Git hooks are installed.

TypeScript and typescript-eslint are pinned to compatible versions. Update them together when upgrading the toolchain.

## Files

- `src/status.ts`: validated configuration and two read-only HTTP calls.
- `src/server.ts`: MCP tool registration and sanitized error output.
- `src/index.ts`: stdio entry point.
- `scripts/check-connection.ts`: one-shot MCP client.
- `test/status.test.ts`: status, error, credential, timeout, redirect and protocol tests.

## References

- https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Core/API/Controllers/ServerController.cs
- https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Core/API/Controllers/ApplicationController.cs
- https://modelcontextprotocol.io/docs/develop/build-server

The official SDK v2 server/client packages are used. Only one tool is registered. Codex configuration and slskd configuration are intentionally managed separately.
