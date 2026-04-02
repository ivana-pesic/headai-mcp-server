# Headai MCP Server — Directory Submission Readiness

## Status Summary (updated 2026-04-02)

| # | Requirement | Status | Notes |
|---|---|---|---|
| 1 | 23 tools with annotations | DONE | All registerTool + annotations |
| 2 | Streamable HTTP transport | DONE | Dual-mode: stdio + HTTP |
| 3 | Bearer token auth | DONE | User provides own API key (like Supermetrics) |
| 4 | CORS for browser clients | DONE | All /mcp routes |
| 5 | Max 25,000 tokens per result | DONE | truncateIfNeeded |
| 6 | Error handling | DONE | handleApiError + 401 rejection |
| 7 | 5 usage examples | DONE | In README + /docs page |
| 8 | Documentation landing page | DONE | /docs with full HTML |
| 9 | /health endpoint | DONE | JSON status |
| 10 | /tools endpoint | DONE | Tool listing JSON |
| 11 | /changelog endpoint | DONE | Version history JSON |
| 12 | HTTPS/TLS | DONE | megatron.headai.com is HTTPS |
| 13 | Privacy policy URL | **TODO** | Need https://headai.com/privacy-policy |
| 14 | Terms of service URL | **TODO** | Need https://headai.com/terms |
| 15 | Support contact | **TODO** | Need support@headai.com or page |
| 16 | GA status declaration | **TODO** | Business decision |
| 17 | Test account for reviewers | **TODO** | Provision dedicated API key |
| 18 | Firewall: Claude IP allowlist | **TODO** | Allowlist Claude IPs on megatron |
| 19 | Deploy to mcp.headai.dev | **TODO** | Lovable deployment |

## Architecture

```
claude.ai / Claude Desktop / Any MCP Client
    │
    │ Authorization: Bearer <user_api_key>
    │ Streamable HTTP (POST/GET/DELETE /mcp)
    │
    ▼
mcp.headai.dev (Lovable)     ← stateless proxy
    │
    │ API-key auth (user's key forwarded)
    │
    ▼
megatron.headai.com          ← Headai Core Engine
```

The server is a **stateless proxy** — no secrets stored, each user provides their own API key. This matches the Supermetrics pattern that's already approved in Claude's MCP Directory.

## Remaining Headai Team Actions

1. **Privacy policy** — publish at headai.com/privacy-policy
2. **Terms of service** — publish at headai.com/terms
3. **Support email** — set up support@headai.com
4. **Test API key** — provision a dedicated key for Anthropic reviewers
5. **Claude IP allowlist** — from https://docs.claude.com/en/api/ip-addresses
6. **Deploy on Lovable** — `MCP_TRANSPORT=http` at `mcp.headai.dev`
7. **Declare GA** — confirm production readiness

## Submission

Once ready, submit via the MCP Directory Server Review Form at:
https://support.claude.com/en/articles/12922490-remote-mcp-server-submission-guide
