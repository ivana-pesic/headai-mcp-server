# Headai MCP Server

Connect Claude, ChatGPT, or any MCP-compatible AI to **Headai's Core Engine APIs** for workforce intelligence, skills analysis, and knowledge graph operations.

## Quick Start

### Option A: npx (no install needed)

```bash
HEADAI_API_KEY=your_key npx -y @headai/mcp-server
```

### Option B: Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "headai": {
      "command": "npx",
      "args": ["-y", "@headai/mcp-server"],
      "env": {
        "HEADAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Option C: Remote (OAuth) — claude.ai

Connect directly at **https://mcp.headai.dev/mcp** — no local install required.

## Features

- **25 tools** covering the full Headai API surface
- **BKG v2** — 4.5x faster knowledge graph builds with built-in semantic cleaning
- **Dual transport**: stdio (local) and Streamable HTTP (remote)
- **Safety annotations** on every tool (readOnlyHint, destructiveHint, idempotentHint)
- **Async polling** for long-running operations (BuildKnowledgeGraph, BuildSignals)
- **Smart truncation** — responses capped at 25K chars for LLM context limits

## Available Tools

| Tool | Category | Description |
|------|----------|-------------|
| `headai_text_to_graph` | Core | Convert free text into a semantic knowledge graph |
| `headai_text_to_keywords` | Core | Extract weighted keywords from text |
| `headai_build_knowledge_graph` | Core | Build graphs from datasets (v1 engine) |
| `headai_build_knowledge_graph_v2` | Core | **Recommended.** Fast builds with semantic cleaning, plural grouping, and focused output |
| `headai_scorecard` | Analysis | Compare two knowledge graphs — gap analysis, coverage scoring |
| `headai_compass` | Recommendations | AI-powered recommendations (jobs, courses, skills, career paths) |
| `headai_build_signals` | Trends | Time series trend analysis — emerging, growing, declining skills |
| `headai_join_graphs` | Transform | Merge multiple knowledge graphs |
| `headai_modify_graph` | Transform | Filter/refine a graph by group, weight, or keywords |
| `headai_translate_graph` | Transform | Translate a graph between languages |
| `headai_digital_twin` | Storage | Store/retrieve competency profiles (AddToTwin, GetTwin, GetSecureShareLink) |
| `headai_visual_report` | Reports | Generate interactive HTML visualizations from a graph |
| `headai_run_analyst` | Reports | Run automated QA/analysis reports on a graph |
| `headai_run_composer` | Reports | Generate strategic HTML documents from 1-3 graphs |
| `headai_fetch_graph` | Utility | Retrieve a graph by its URL |
| `headai_fetch_and_save` | Utility | Fetch a graph and save to local file |
| `headai_describe_graph` | Utility | Get human-readable description of a graph's contents |
| `headai_check_build_status` | Utility | Check status of async operations (BKG, Signals) |
| `headai_estimate_size` | Utility | Estimate result size before building |
| `headai_list_token_endpoints` | Admin | List API endpoints available for your key |
| `headai_list_token_data` | Admin | List data built with your key |
| `headai_skills_profiler` | Career | Build a personal skills graph from CV + KOSKI data |
| `headai_career_navigator` | Career | Full career analysis: profile, market comparison, recommendations |
| `headai_foresight_agent` | Career | Skills trend forecasting for career planning |
| `headai_get_playbook` | Guide | Get the complete tool usage playbook |

## Datasets

BKG v2 supports these datasets:

| Dataset | Description | Requires search_year? |
|---------|-------------|----------------------|
| `job_ads` | Finnish job advertisements | No (defaults to current) |
| `investments` | Investment and funding data | Yes |
| `doaj` | Open-access research articles | Yes |
| `theseus` | Finnish university theses | No |
| `tiedejatutkimus` | Finnish research database | No |
| `curriculum` | Educational curricula | No |
| `news` | News articles | Yes |

**Note:** v2 dataset names differ from v1 (`investments` not `investment_data`, `doaj` not `doaj_articles`).

## Usage Examples

### Build a knowledge graph (v2)

**Prompt:** "What AI skills are Finnish employers looking for?"

The server calls `headai_build_knowledge_graph_v2` with dataset `job_ads`, Finnish software/AI keywords, and gets a focused, clean graph in ~20-30 seconds.

### Compare curriculum vs. job market

1. Build graph A from `curriculum` dataset
2. Build graph B from `job_ads` with relevant keywords
3. Run `headai_scorecard` comparing both

Returns: coverage %, matched skills, gap skills, surplus skills.

### Detect skill trends over time

1. Build snapshots for 2022, 2023, 2024, 2025
2. Run `headai_build_signals` with all URLs in chronological order

Returns: skills classified as Emerging, Increasing, Constant, Declining, or Disappearing.

### Cross-source horizon analysis

1. `job_ads` — present state (what employers need now)
2. `investments` — near future 1-3yr (where money is flowing)
3. `doaj` — far future 5-10yr (what researchers are working on)
4. `headai_build_signals` across all three

### Personal career recommendations

Run `headai_compass` with your skills list and get AI-powered recommendations in the Zone of Proximal Development — skills that are reachable given your current competencies.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEADAI_API_KEY` | Yes | — | Your Headai API key |
| `HEADAI_API_URL` | No | `https://megatron.headai.com` | API base URL |
| `MCP_TRANSPORT` | No | `stdio` | Transport: `stdio` or `http` |
| `MCP_PORT` | No | `3000` | HTTP port (http mode only) |
| `MCP_HOST` | No | `0.0.0.0` | HTTP bind address |

## Architecture

```
Claude Desktop / Claude Code / claude.ai / ChatGPT
    |
    | stdio (local) or Streamable HTTP (remote)
    v
@headai/mcp-server (25 tools)
    |
    | HTTPS + API-key auth
    v
Headai Core Engine (megatron.headai.com)
    +-- TextToGraph / TextToKeywords
    +-- BuildKnowledgeGraph v1 + v2 (async polling)
    +-- Scorecard / Compass
    +-- BuildSignals (async polling)
    +-- Join / Modify / Translate
    +-- DigitalTwinStorage
    +-- Analyst + Composer (qa.headai.com)
```

## Technical Notes

- BKG v2 is ~4.5x faster than v1 (~20-30s vs ~85s) and produces focused, pre-cleaned graphs
- Async operations auto-poll every 3s for up to 6 minutes
- Responses truncated at 25K chars to fit LLM context windows
- Compass has a 320s timeout due to intensive computation
- Megatron has 2 cores per API key — max 1 concurrent Compass call

## Get an API Key

Contact Headai at [headai.com](https://headai.com) for API key provisioning.

## License

MIT
