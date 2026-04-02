# Headai MCP Server

Connect Claude (or any MCP-compatible AI) to **Headai's Core Engine APIs** for workforce intelligence, skills analysis, and knowledge graph operations.

## Features

- **23 tools** covering the full Headai API surface
- **Dual transport**: stdio (local) and Streamable HTTP (remote)
- **Safety annotations** on every tool (readOnlyHint, destructiveHint, idempotentHint)
- **Async polling** for long-running operations (BuildKnowledgeGraph, BuildSignals)
- **Smart truncation** — responses capped at 25K chars for LLM context limits

## Available Tools

| Tool | Category | Description |
|------|----------|-------------|
| `headai_text_to_graph` | Core | Convert free text into a semantic knowledge graph |
| `headai_text_to_keywords` | Core | Extract weighted keywords from text |
| `headai_build_knowledge_graph` | Core | Build graphs from datasets (job ads, research articles, curricula, investment data, news) |
| `headai_scorecard` | Analysis | Compare two knowledge graphs — gap analysis, coverage scoring |
| `headai_compass` | Recommendations | AI-powered recommendations (jobs, courses, skills, career paths) |
| `headai_build_signals` | Trends | Time series trend analysis — emerging, growing, declining skills |
| `headai_join_graphs` | Transform | Merge multiple knowledge graphs |
| `headai_modify_graph` | Transform | Filter/refine a graph by group, weight, or keywords |
| `headai_translate_graph` | Transform | Translate a graph between languages |
| `headai_digital_twin` | Storage | Store/retrieve competency profiles (AddToTwin, GetTwin, GetSecureShareLink) |
| `headai_fetch_graph` | Utility | Retrieve a graph by its URL |
| `headai_fetch_and_save` | Utility | Fetch a graph and save to local file |
| `headai_describe_graph` | Utility | Get human-readable description of a graph's contents |
| `headai_estimate_size` | Utility | Estimate result size before building (calibrate size param) |
| `headai_list_token_endpoints` | Admin | List all API endpoints available for your key |
| `headai_list_token_data` | Admin | List all data built with your key for an endpoint |
| `headai_get_jobs_by_text` | Jobs | Find matching job listings from a text description |
| `headai_autocomplete_job_title` | Jobs | Autocomplete job title strings |
| `headai_job_title_relations` | Jobs | Get skills related to a job title |
| `headai_autocomplete_industry` | Jobs | Autocomplete industry strings |
| `headai_industry_relations` | Jobs | Get skills related to an industry |
| `headai_run_analyst` | Reports | Run automated QA/analysis reports on a graph |
| `headai_run_composer` | Reports | Generate strategic HTML documents from 1-3 graphs |

## Setup

### Option A: Local (stdio) — Claude Desktop / Claude Code

```bash
cd headai-mcp-server
npm install
npm run build
```

Add to Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "headai": {
      "command": "node",
      "args": ["/path/to/headai-mcp-server/dist/index.js"],
      "env": {
        "HEADAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Option B: Remote (HTTP) — MCP Directory / claude.ai

```bash
MCP_TRANSPORT=http MCP_PORT=3000 HEADAI_API_KEY=your_key node dist/index.js
```

Or use the npm script:

```bash
npm run start:http
```

Production endpoint: `https://mcp.headai.dev/mcp`

The server exposes:
- `GET /health` — health check endpoint
- `POST /mcp` — MCP protocol (Streamable HTTP)
- `GET /mcp` — SSE stream for session
- `DELETE /mcp` — session termination

## Usage Examples

### Example 1: Build a knowledge graph from job ads

**User prompt:** "What AI skills are Finnish employers looking for right now?"

The server calls `headai_build_knowledge_graph` with:
- dataset: `job_ads`
- search_text: `artificial intelligence, machine learning, deep learning, neural networks, computer vision, natural language processing, LLM, transformer, generative AI, data science, MLOps, model training, inference, reinforcement learning, AI engineering, prompt engineering, RAG, fine-tuning, embedding, vector database`
- language: `en`
- country: `fi`
- size: 200

Returns a knowledge graph with ranked skills nodes, their weights, and connections — visualizable at `cloud.headai.com/public/HeadaiVisualizer.html?json_url=<graph_url>`.

### Example 2: Compare curriculum vs. job market (Scorecard)

**User prompt:** "Compare our data science curriculum against what employers actually need"

1. Build snapshot A: `headai_build_knowledge_graph` from `curriculum` dataset for the institution
2. Build snapshot B: `headai_build_knowledge_graph` from `job_ads` with data science keywords
3. Run `headai_scorecard` comparing the two graphs

Returns coverage percentage, matched skills, gap skills (in demand but missing from curriculum), and surplus skills (taught but not in demand).

### Example 3: Detect trending skills over time (Signals)

**User prompt:** "How have cybersecurity skills evolved from 2022 to 2025?"

1. Build snapshots for 2022, 2023, 2024, 2025 from `job_ads`
2. Run `headai_build_signals` with the 4 graph URLs in chronological order

Returns skills classified into 8 signal groups: Emerging (new), Constantly Increasing, Increasing in last period, Constant, Declining, and Disappearing.

### Example 4: Cross-source horizon analysis

**User prompt:** "What does the future look like for autonomous vehicles — from current jobs through investment to research?"

1. Build from `job_ads` (present state)
2. Build from `investment_data` with search_year (near future 1-3yr)
3. Build from `doaj_articles` with search_year (far future 5-10yr)
4. Run `headai_build_signals` in ascending horizon order

### Example 5: Personal career recommendations (Compass)

**User prompt:** "I know Python, SQL, and basic ML. What should I learn next for a data engineering career?"

Run `headai_compass` with:
- skills: `["Python", "SQL", "machine learning basics"]`
- mode: `learning_path`
- namespace: `headai` (or `esco` for European standard)

Returns prioritized recommendations in the Zone of Proximal Development — skills that are reachable given current competencies.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEADAI_API_KEY` | Yes | — | Your Headai API key |
| `HEADAI_API_URL` | No | `https://megatron.headai.com` | API base URL |
| `MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | No | `3000` | HTTP server port (http mode only) |
| `MCP_HOST` | No | `0.0.0.0` | HTTP bind address (http mode only) |
| `MCP_ALLOWED_HOSTS` | No | — | Comma-separated allowed Host headers (http mode) |

## Architecture

```
Claude Desktop / Claude Code / claude.ai
    │
    │ stdio (local) or Streamable HTTP (remote)
    │
    ▼
headai-mcp-server (23 tools)
    │
    │ HTTPS + API-key auth
    │
    ▼
Headai Core Engine (megatron.headai.com)
    ├── TextToGraph / TextToKeywords
    ├── BuildKnowledgeGraph (async polling)
    ├── Scorecard / Compass
    ├── BuildSignals (async polling)
    ├── Join / Modify / Translate
    ├── DigitalTwinStorage
    ├── Utils (estimate, list, describe)
    ├── Analyst (qa.headai.com:8081)
    └── Composer (qa.headai.com:8081)
```

## Technical Notes

- Async operations (BKG, Signals) auto-poll every 3s for up to 6 minutes
- Responses truncated at 25K chars to fit LLM context windows
- All tools have MCP safety annotations (readOnlyHint, destructiveHint, idempotentHint)
- `doaj_articles`, `investment_data`, and `news` datasets require `search_year` parameter
- Compass has a 320s timeout due to intensive computation
- Megatron has 2 cores per API key — max 1 concurrent Compass call recommended

## Privacy

Headai processes text through its AI engine. By default, input text may be stored temporarily for processing. The `headai_text_to_graph` tool supports a `high_privacy_mode` option that prevents server-side storage of input text.

## Support

For API key provisioning and technical support, contact Headai at https://headai.com.
