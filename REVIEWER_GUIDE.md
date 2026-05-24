# Reviewer Setup Guide — Headai MCP Server

## Quick Start (5 minutes)

### 1. Connect via MCP URL

**Server URL:** `https://mcp.headai.dev/mcp`

The server supports OAuth 2.0 authentication. On first connection, you'll be redirected to the Headai authorization page. Click "Authorize" to grant access.

### 2. Test API Key

A dedicated test key is provisioned for marketplace reviewers:

- **Key name:** `Space_test_key_for_stores`
- **API Key:** *(provided separately via the submission form — not stored in public repo)*

This key has full access to all endpoints and tools. It is rate-limited to 2 concurrent heavy operations (same as production keys).

### 3. Verify Connection

After connecting, call the `headai_get_playbook` tool. It requires no parameters and should return the orchestration playbook text. If this succeeds, the connection is working.

---

## Suggested Test Scenarios

### Scenario A: Build a Knowledge Graph (read-only, ~60s)

1. Call `headai_build_knowledge_graph_v2` with:
   - `dataset`: "job_ads"
   - `language`: "en"
   - `search_text`: "data engineering, machine learning, python, kubernetes, spark, airflow"
   - `legend`: "Data Engineering Market"
   - `size`: 100
   - `focused_build`: true
   - `word_type`: "only_compounds"

2. The first call returns a **preview** with estimated data size and a `preview_hash`.
3. Call again with the same parameters + `preview_hash` to start the build.
4. Call `headai_check_build_status` with the returned `status_url` until status is "ready".
5. Result includes `graph_url` and `visualizer_url` (viewable in browser).

### Scenario B: Compare Two Texts (Scorecard)

1. Call `headai_text_to_graph` with a short CV text (language: "en")
2. Call `headai_text_to_graph` with a job description text (language: "en")
3. Call `headai_scorecard` with both graph URLs → returns match score + gap analysis

### Scenario C: Get Recommendations (Compass)

1. Call `headai_compass` with:
   - `skills`: ["python", "data analysis", "machine learning", "sql"]
   - `namespace`: "linkedin_learning"
   - `request`: ["match"]
   - `language`: "en"

Returns ranked course recommendations with match scores.

---

## Architecture Notes

- **Transport:** Streamable HTTP (primary) + SSE (legacy)
- **Auth:** OAuth 2.0 with Bearer token
- **Hosting:** Railway (auto-deploy from GitHub main)
- **Backend API:** megatron.headai.com (Headai Core Engine, 2 cores per API key)
- **All tools are read-only** — no data is modified or deleted by any tool call

## Rate Limits & Timeouts

- Heavy operations (BKG, Compass, Signals): 1 concurrent per key, up to 320s timeout
- Light operations (TextToGraph, Scorecard, Analyst): effectively unlimited, <10s
- The server sends heartbeat messages to keep long connections alive

## Support

If you encounter issues during review, contact: info@headai.com
