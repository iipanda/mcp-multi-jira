# mcp-multi-jira

Multi-account Jira MCP server. Configure multiple Atlassian Jira accounts and route tool calls by account alias.

## Project goals

Most Jira MCP setups are single-account, which gets painful if you regularly switch between:

- work + personal Jira
- multiple clients/tenants
- separate Jira sites with different permissions

This project exists to provide a **single MCP server** that can hold **multiple Jira accounts** and route every tool call via an explicit `account` parameter (so your agent config stays stable while you tell it to use different accounts in prompts).

This project has features like:

- optional encrypted or OS keychain token storage
- works with common MCP clients (Cursor, Claude Code, Codex CLI)
- automatic installation of MCP configs for supported agents

## Quick start

First, set up your account(s):

```bash
npx -y mcp-multi-jira login Work
npx -y mcp-multi-jira login Personal
```

Then, install the MCP in your favorite coding agent:

```bash
npx -y mcp-multi-jira install
```

That's it! Restart your coding agent / IDE to pick up the new MCP server.

## CLI reference

Log in an account:

```bash
mcp-multi-jira login WorkJira
```

List accounts:

```bash
mcp-multi-jira list
```

Start the server:
(Note: server will be started automatically by the agents if you use the install command)

```bash
mcp-multi-jira serve
```

Install MCP configuration for supported agents:

```bash
mcp-multi-jira install
```

## Advanced usage

### Change token storage

By default, tokens are stored in a plaintext file. To use encryption or the OS keychain, set the default backend once with:

```bash
# Options: plain (default), encrypted, keychain
mcp-multi-jira token-store encrypted
```

If you use encrypted storage, make sure your environment has the master password set, otherwise the MCP will fail to start:

```bash
export MCP_JIRA_TOKEN_PASSWORD="your-master-password"
```

Plaintext tokens are stored at `~/.mcp-jira/tokens.json` (do not use on shared machines).

When switching token stores and accounts already exist, the CLI will prompt to migrate tokens to the new backend.

### Override OAuth client

```bash
export MCP_JIRA_CLIENT_ID="your-client-id"
export MCP_JIRA_CLIENT_SECRET="your-client-secret"
```

## Manual agent configuration

You can auto-install agent configs:

```bash
mcp-multi-jira install
```

Below are manual snippets for advanced setups.

### Cursor

`~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-jira": {
      "command": "npx",
      "args": ["-y", "mcp-multi-jira", "serve"]
    }
  }
}
```

### Claude Code

`~/.claude/mcp_servers.json`:

```json
{
  "mcpServers": {
    "mcp-jira": {
      "command": "npx",
      "args": ["-y", "mcp-multi-jira", "serve"]
    }
  }
}
```

### OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.mcp_jira]
command = "npx"
args = ["-y", "mcp-multi-jira", "serve"]
```
