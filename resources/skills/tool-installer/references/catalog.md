# Tool Catalog

Curated list of recommended tools. Read this when users ask "what tools can I add" or when looking up install details for a specific service.

## MCP Servers (no credentials needed)

| Name | Package | Description |
|------|---------|-------------|
| Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | Step-by-step reasoning with reflection, improves complex problem solving |
| Memory | `@modelcontextprotocol/server-memory` | Persistent knowledge graph for cross-session memory |
| Time | `@modelcontextprotocol/server-time` | Timezone conversion and current time queries |
| SQLite | `@modelcontextprotocol/server-sqlite` | Query and analyze SQLite databases |
| Git | `@modelcontextprotocol/server-git` | Read, search, and navigate Git repositories |

## MCP Servers (credentials required)

| Name | Package | Credentials |
|------|---------|-------------|
| GitHub | `@modelcontextprotocol/server-github` | `GITHUB_TOKEN` — free at github.com/settings/tokens |
| Brave Search | `@modelcontextprotocol/server-brave-search` | `BRAVE_API_KEY` — free tier 2000 calls/month at brave.com/search/api |

## MCP Servers (Python, use `uvx`)

These require Python/uv installed. Use `command: "uvx"` instead of `npx`.

| Name | Package | Description |
|------|---------|-------------|
| Fetch | `mcp-server-fetch` | Fetch web content as clean Markdown |
| Puppeteer | `mcp-server-puppeteer` | Browser automation and screenshots |

Config format for Python servers:
```json
{ "command": "uvx", "args": ["mcp-server-fetch"], "env": {} }
```

## CLI Tools

| Name | Install | Description | Skills |
|------|---------|-------------|--------|
| Feishu/Lark | `npm i -g @larksuite/cli` | Feishu messaging, calendar, docs, 200+ commands | `npx skills add larksuite/cli -y -g` |
| GitHub CLI | `brew install gh` | GitHub repos, PRs, issues from terminal | Built-in knowledge |
| Vercel | `npm i -g vercel` | Deploy and manage Vercel projects | — |
| Supabase | `npm i -g supabase` | Supabase backend-as-a-service | — |
| Wrangler | `npm i -g wrangler` | Cloudflare Workers management | — |

## Adding a tool not in this catalog

If the user wants a tool not listed here:
1. Search npm for `@modelcontextprotocol/server-<name>` or `mcp-server-<name>`
2. Check the package README for required args and env vars
3. Follow the standard MCP or CLI installation workflow from SKILL.md
