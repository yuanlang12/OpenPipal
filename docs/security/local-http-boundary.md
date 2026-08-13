# Local HTTP and browser-extension boundary

OpenPipal binds its HTTP server to `127.0.0.1`, but loopback by itself is not an
authorization boundary. Every request must also use the active server port and
an exact `localhost` or `127.0.0.1` Host header. This rejects DNS-rebinding and
stale-port requests before request bodies are read.

Dynamic routes use two process-local principals:

- **Native** uses the private `~/.openpipal/acp-mcp.token` capability. The legacy
  `X-OpenPipal-ACP-Token` header remains supported; the token is never returned
  by HTTP, placed in a URL, or sent to renderer/extension code.
- **Browser** uses a separate process-lifetime capability. An exact
  `chrome-extension://<32 character id>` origin requests it from
  `POST /extension/session`; the first origin is pinned until restart. Browser
  authority is an explicit allowlist for context, conversations, chat,
  browser-only permission replies, and the renderer data needed by those
  flows. It may read the already-masked model summary and use bounded product
  routes such as conversations, memory restore, and app visibility settings.
  It cannot read raw keys, mutate/test model configuration, register session
  MCP servers, import/delete arbitrary local paths, or package an arbitrary
  local directory.

Only `GET /health`, the path-free `GET /extension` installation guide, the
renderer shell/assets, and read-only design-system resources are public. CORS
never uses `*`: it reflects only the pinned extension
origin and sends `Vary: Origin`. Browser-control WebSocket connections must use
the same Host and pinned Origin, and their first message must be an authenticated
`register` message before they can receive or send commands.

Task webhooks are a separate external entrypoint. A task must have an explicit
`X-OpenPipal-Secret`; legacy tasks without a secret fail closed. Authorization
headers and the webhook secret are stripped before event metadata is passed to
the Agent.

## Minimum threat boundary

The extension bootstrap prevents arbitrary web pages from calling OpenPipal.
Chrome supplies the real Origin for browser fetch/WebSocket traffic, but a
malicious locally installed extension or a local process can imitate that
header and race the first-origin binding. Protecting against an already-hostile
local account requires a future OS-backed pairing or Chrome native-messaging
host. This limitation is explicit rather than treating Origin alone as a
machine-local identity.
