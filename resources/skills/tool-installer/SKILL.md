---
name: tool-installer
description: >
  Install and configure MCP servers, CLI tools, and their companion skills for
  the user. Use when the user asks to: add/install a tool or plugin, connect
  an external service (Feishu, GitHub, Slack, etc.), set up an MCP server,
  register a CLI command, or asks "what tools can I add". Also triggers when
  the user mentions a specific service name and implies wanting to use it
  through OpenPipal.
---

# Tool Installer

Help users discover, install, and configure tools through conversation.

## Two types of tools

| Type | What it is | Config file | Install method |
|------|-----------|-------------|----------------|
| **MCP server** | Long-running process exposing tools via MCP protocol | Managed by **插件 > 工具** | npm package, URL, or custom command entered in the UI |
| **CLI tool** | Command-line program called via bash | `~/.openpipal/cli-tools.json` | `npm install -g` / `brew install` / etc. |

## Installation workflow

### MCP server

1. Determine the npm package name (see [catalog](references/catalog.md))
2. Explain the exact values the user should enter in **插件 > 工具 > 添加工具**:
   - npm server: display name + package name
   - remote server: display name + HTTP(S) URL, plus OAuth if required
   - custom server: display name + command + arguments
3. Ask the user to use the page's **测试连接** action before saving.
4. After the user saves it, tell them the server connects immediately and can be checked on the same page.

The MCP configuration is a protected credential boundary because entries may
contain environment variables, authorization headers, or OAuth state. Never
use `read`, `write`, `edit`, `bash`, or code execution to inspect or modify
`~/.openpipal/mcp-servers.json`. OpenPipal's trusted settings UI is the only
supported configuration path.

### CLI tool

1. Install the CLI:
   ```bash
   npm install -g @larksuite/cli
   # or: brew install gh
   ```
2. Install companion skills if available:
   ```bash
   npx skills add <repo> -y -g 2>/dev/null || echo "No skills package"
   ```
3. Register in `~/.openpipal/cli-tools.json`:
   ```json
   [
     { "name": "Display Name", "command": "cmd", "description": "What it does", "category": "saas" }
   ]
   ```
   Categories: `dev` | `saas` | `system` | `ai`
4. If the tool needs credentials (OAuth, API key), guide the user through setup using `ask_user` for URLs.

## Credential setup pattern

Many tools need OAuth or API keys. Standard flow:

1. Run the auth command in background, capture the URL:
   ```bash
   lark-cli config init --new 2>&1
   ```
2. Present the URL to the user via `ask_user`:
   > "请在浏览器中打开此链接完成授权：https://..."
3. Wait for confirmation, then verify:
   ```bash
   lark-cli auth status
   ```

## Popular tools

See [references/catalog.md](references/catalog.md) for a curated list of recommended MCP servers and CLI tools with install instructions.

## Important notes

- Always check if a tool is already installed before installing (`which <command>`)
- For MCP servers, never access the underlying config file; use **插件 > 工具**
- Never store API keys or secrets in plain text config files; use env vars or keychain
- After adding tools, suggest the user visit **插件 > 工具** to verify
