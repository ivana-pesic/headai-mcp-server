# Headai Core Engine API Reference

Base URL: `https://megatron.headai.com`
Auth header: `Authorization: API-key <HEADAI_API_KEY>`
All endpoints: POST with JSON body, Content-Type: application/json

**Note:** Use the MCP tools (headai_text_to_graph, etc.) instead of curl. They handle auth and async polling automatically.

**NEVER use `high_privacy_mode: true`** — it breaks downstream workflows. Graph URLs become unusable for chaining.

---

## TextToGraph

Converts free-form text into a semantic knowledge graph using Headai's Graphmind AI.

**POST** `/TextToGraph`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| text | string | yes | The text to analyze |
| language | string | no | ISO code: "en", "fi", "sv", "de", etc. Default: "en" |
| ontology | string | no | "headai" (default), "lightcast", "esco". Avoid "yso" (0 terms) |
| legend | string | no | Label for the graph |
| output | string | no | "json" (default) or "url" |
| update | string | no | "false" to get fresh result. Default: "false" |
| word_type | string | no | "only_compounds" for precise terms, "none" for all words |

**Response:** DeepGraph JSON. Edges in `data.edges[]`, nodes in `data.nodes[]`.

---

## TextToKeywords

Extracts weighted keywords from text. Lighter-weight than TextToGraph when you only need keyword extraction.

**POST** `/TextToKeywords`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| text | string | yes | Text to extract keywords from |
| language | string | no | ISO code. Default: "en" |
| ontology | string | no | Default: "headai" |
| only_compounds | boolean | no | If true, only multi-word terms |
| noise_list | string | no | Comma-separated words to exclude |

**Response:** JSON array of keywords with weights and values.

---

## BuildKnowledgeGraph (ASYNC)

Builds a knowledge graph from a Headai dataset. This is the "Snapshot" method in decision logic.

**POST** `/BuildKnowledgeGraph`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| dataset | string | yes | "job_ads", "curriculum", "theseus", "doaj_articles", "investment_data", "news", "jobs_by_company_name" |
| language | string | no | Default: "en". doaj_articles always "en" |
| ontology | string | no | Default: "headai". Only "lightcast" supports additional_data=true |
| search_text | string | yes* | ~20 domain-specific keywords, comma-separated. Hyphens=AND, commas=OR |
| search_year | **integer** | no | Year filter (e.g., 2025). Use 0 for all years |
| search_month | **integer** | no | Month filter (e.g., 3). Use 0 for all months |
| search_day | **integer** | no | Day filter (e.g., 15). Use 0 for all days |
| country | string | no | Country code ("fi", "de"). job_ads/curriculum only. Mutually exclusive with city |
| city | string | no | City name. job_ads/curriculum only. Mutually exclusive with country |
| affiliation | string | no | Institution name. doaj_articles/theseus only |
| size | integer | no | Number of top concepts. 1-5000, default 5000. Use 200 for standard, 500-1000 for city-level |
| output | string | no | "json" or "url" |
| word_type | string | no | "only_compounds" for precise terms, "none" for all words |
| additional_data | boolean | no | Only works with lightcast ontology |
| weighted_search_output | boolean | no | Only works with job_ads dataset |

*search_text is technically optional but practically required for meaningful results.

**Response (initial):**
```json
{"status": "work in progress", "location": "https://megatron.headai.com/analysis/BuildKnowledgeGraph/..."}
```

**Polling:** GET the `location` URL every 3 seconds. When `status` becomes `"ready"`, the `location` URL returns the final DeepGraph JSON.

---

## Scorecard (ASYNC)

Compares two knowledge graphs and produces gap analysis.

**POST** `/Scorecard`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| map_url_1 | string | mode 1 | URL to first graph |
| map_url_2 | string | mode 1 | URL to second graph |
| text_1 | string | mode 2 | Raw text for first comparison |
| text_2 | string | mode 2 | Raw text for second comparison |
| item | string | mode 3 | Graph URL/ID for precalculated comparison |
| scorecard | string | mode 3 | Scorecard template name (e.g., "sdg_en", "sdg_fi") |
| legend_1 | string | no | Label for first graph |
| legend_2 | string | no | Label for second graph |
| language | string | no | Default: "en" |
| ontology | string | no | "headai" (default), "lightcast", "esco", "fibo" |
| output | string | no | "json" or "url" |
| limit | number | no | Exclude weights lower than value (0-5). 0=all, 5=only most important |
| noise_list | string | no | Comma-separated keywords to exclude from results |
| use_stored_noise | boolean | no | Use noise list stored for API key |
| important_topics | string | no | Comma-separated key topics to check for |

**Four input modes** (can be mixed — e.g., map_url_1 + text_2):
1. Graph vs Graph: `map_url_1` + `map_url_2`
2. Text vs Text: `text_1` + `text_2` (slow — internally runs TextToGraph on both)
3. Graph vs Precalculated: `item` + `scorecard`
4. Mixed: `map_url_1` + `text_2` (or vice versa)

**SDG Scorecard presets:**
- `sdg_en` — UN Sustainable Development Goals (English)
- `sdg_fi` — SDGs in Finnish

**Response:** DeepGraph with 3 groups + extra fields:
- Group 1: Common concepts (shared by both)
- Group 2: Unique to first graph/text (left)
- Group 3: Unique to second graph/text (right)
- `data.scores`: full_score, full_score_normalized, important_topics_score, important_topics_found[], important_topics_missing[]
- `data.indicators`: data_quality_factor, data_size_balance, meaningful_words_count
- `data.sources`: [{id, title, url}]

---

## Compass (SYNC)

AI-powered recommendations matching a profile against a target namespace. Synchronous but slow (~320s timeout).

**POST** `/Compass`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| data.skills | array | yes | Array of skill strings from user's profile |
| data.interests | array | no | Array of interest/goal strings |
| data.namespace | string | yes | Target namespace (see namespace catalog in SKILL.md) |
| data.request | array | yes | Modes: "match", "zpd", "demand", "jobs", "companies", "curriculum", "researcher" |
| data.language | string | no | "en" or "fi". Default: "en" |
| data.completed | array | no | Completed courses (course recs only) |
| data.mandatory | array | no | Mandatory courses (course recs only) |
| data.suggest_from_set | array | no | Constrain results to these course IDs |
| data.country_limit | array | no | ISO country codes for job search, e.g. ["fi"] |
| data.city_limit | array | no | City names for job search, e.g. ["helsinki"] |
| output | string | yes | Always "json" |

**Two request schemas:**

Course recommendations:
```json
{
  "output": "json",
  "data": {
    "namespace": "metropolia",
    "request": ["match", "zpd"],
    "skills": ["python", "programming"],
    "interests": ["web_development"],
    "language": "en",
    "completed": [],
    "mandatory": [],
    "suggest_from_set": []
  }
}
```

Job recommendations (MUST include "jobs" in request array):
```json
{
  "output": "json",
  "data": {
    "namespace": "any",
    "request": ["jobs", "match"],
    "skills": ["python", "programming"],
    "interests": ["web_development"],
    "language": "en",
    "country_limit": ["fi"],
    "city_limit": ["helsinki"]
  }
}
```

**Request modes:**
| Mode | Purpose | Use with |
|------|---------|----------|
| match | Best skill overlap | courses + jobs |
| zpd | Zone of Proximal Development (stretch) | courses + jobs |
| demand | Market demand-based | courses |
| jobs | **REQUIRED** for job namespaces | jobs only |
| companies | Company recommendations | jobs |
| curriculum | Curriculum matches | courses |
| researcher | Research opportunities | research |

Can combine: `["match", "zpd", "demand"]` or `["jobs", "match"]`

**Note:** Only 1 concurrent Compass call per API key. Queue if multiple needed.

**Response:**
```json
{
  "data_quality_summary": ["..."],
  "data_size": 23295,
  "recommendations_based_on_matching_skills": [...],
  "recommendations_based_on_extensive_skills": [...],
  "recommendations_based_on_skills_demand": [...]
}
```

Each recommendation: code, url, title, short_description, explanation, new_skills, existing_skills, interests, quality_index, scoring_index.

---

## JoinKnowledgeGraph

Merges two or more knowledge graphs into one.

**POST** `/JoinKnowledgeGraph`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| urls | string | mode 1 | Comma-separated URLs to graph JSONs |
| graph_1 | object | mode 2 | First graph as JSON object |
| graph_2 | object | mode 2 | Second graph as JSON object |
| title | string | no | Label for merged result |
| output | string | no | "json" |

**Two input modes:**
1. URL mode: `urls: "url1,url2"`
2. Object mode: `graph_1: {...}, graph_2: {...}` — use when you already have graphs in memory

---

## ModifyKnowledgeGraph

Filters and refines a knowledge graph.

**POST** `/ModifyKnowledgeGraph`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| map_url | string | yes | URL to the graph to modify |
| keywords | string | no | Comma-separated keywords to keep |
| weight | integer | no | Minimum weight threshold |
| value | integer | no | Minimum value threshold |
| max_nodes | integer | no | Maximum nodes to retain |
| legend | string | no | Comma-separated legend labels for the graph |
| language | string | no | Default: "en" |
| output | string | no | "json" |

---

## TranslateKnowledgeGraph

Translates a graph to another language, preserving structure.

**POST** `/TranslateKnowledgeGraph`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| url | string | mode 1 | URL to the graph |
| data | object | mode 2 | Graph JSON object (alternative to url). Do not use both. |
| language | string | yes | Source language code (ISO 639-1) |
| translate_to | string | yes | Target language code |
| output | string | no | "json" |

**Supported target languages:** BG, CS, DA, DE, EL, EN, ES, ET, FI, FR, HU, ID, IT, JA, LT, LV, NL, PL, PT, RO, RU, SK, SL, SV, TR, UK, ZH

---

## BuildSignals (ASYNC)

Builds a Signals (time series) analysis from 2+ knowledge graph snapshots in ascending chronological order. Identifies which concepts are emerging, increasing, stable, declining, or disappearing over time. Can optionally predict the next time period.

**POST** `/BuildSignals`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| urls | string | yes | **Comma-separated** graph URLs in ascending time series order. Minimum 2. |
| map_legends | string | yes | **Comma-separated** labels, one per URL. If predict=true, MUST be years (e.g. "2020,2022,2024"). If predict=false, can be any free text (e.g. "Labor Market,Investments,Research"). |
| predict | boolean | yes | Generate prediction for next period. When true, map_legends MUST be year numbers. Default: false. |
| dataset | string | yes | "doaj", "job_ads", or "custom". Controls auto-title generation. Use "custom" for user-provided graphs. |
| title | string | yes | Base title for the series (e.g. "Skills demand prediction"). Combined with dataset to generate per-map titles. |
| output | string | yes | "json" |

Response follows the same async polling pattern as BuildKnowledgeGraph.

**Response structure:**
```json
{
  "data": [
    {"buttonTitle": "2022", "title": "TITLE - 2022", "hideLegend": true, "url": "snapshot_url_1"},
    {"buttonTitle": ">", "title": "Changes between 2022 and 2023", "url": "change_map_url"},
    {"buttonTitle": "2023", "title": "TITLE - 2023", "hideLegend": true, "url": "snapshot_url_2"},
    {"buttonTitle": ">", "title": "Changes between 2023 and 2024", "url": "change_map_url"},
    {"buttonTitle": "2024", "title": "TITLE - 2024", "hideLegend": true, "url": "snapshot_url_3"},
    {"buttonTitle": ">", "title": "Prediction for 2025", "url": "prediction_change_url"},
    {"buttonTitle": "2025", "title": "TITLE - Prediction for 2025", "hideLegend": true, "url": "prediction_url"}
  ],
  "info": {"timeLabels": ["2022", "2023", "2024", "2025"]}
}
```

**Signal groups in change maps (up to 8):**

| Group | Name | Meaning |
|-------|------|---------|
| 1 | Emerging | New concept not seen before |
| 2 | Constantly Increasing | Growing across all snapshots |
| 3 | Increasing in last Map | Growth only in most recent period |
| 4 | Constant value | Stable across all snapshots |
| 5 | Constant in last Map | Stable in most recent period |
| 6 | Constantly Decreasing | Declining across all snapshots |
| 7 | Decreasing in last Map | Decline only in most recent period |
| 8 | Disappearing | Concept no longer present |

**Visualization:** `https://megatron.headai.com/mapSeries.html?json_url=<result_url>`

**Notes:**
- All input graphs must be fully built (ready) before calling BuildSignals
- 3+ snapshots recommended for robust trend detection, but 2 works
- predict=true extrapolates linearly — more data points = better prediction
- Signal output can be analyzed with Analyst reports 400-408

---

## Analyst Reports (run-junior)

Run analytical sub-reports on knowledge graphs, scorecards, or signals.

**Base URL:** `https://qa.headai.com:8081`

**GET** `/run-junior`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| url | string | yes | URL of the graph/scorecard/signals JSON to analyze |
| report | integer | no | Report type ID (default: 0). See report catalog below |
| mode | integer | no | Mode bitmask (default: 0). Recommended: 1280 (PLAIN+TOP100) |
| output | string | no | "plain" for plain text output |
| domain | string | no | Industry/domain context for the analysis |

**Mode Flags (bitmask — combine with +):**

| Flag | Value | Description |
|------|-------|-------------|
| USE_GPT | 1 | Use LLM for noise removal / analysis |
| DO_SUGGESTIONS | 2 | Include suggestions |
| EMBED_LINKS | 4 | Embed visualization links |
| LANG_FINNISH | 8 | Finnish language output |
| TOP10 | 16 | Limit to top 10 results |
| TOP20 | 32 | Limit to top 20 results |
| OUTPUT_PLAIN | 256 | Plain text output |
| OUTPUT_JSON | 512 | JSON output |
| TOP100 | 1024 | Limit to top 100 results |

**Recommended:** mode=1280 (OUTPUT_PLAIN + TOP100). For LLM-powered reports (13, 14, 15): mode=1 (USE_GPT).

**Response:** Plain text report. Content-Type: text/plain.

---

## Composer Reports

Generate full strategic reports combining multiple Analyst sub-reports into a cohesive HTML document.

**POST** `/composer`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| json1 | string | yes | URL to first graph |
| json2 | string | no | URL to second graph (for comparison) |
| json3 | string | no | URL to third graph (e.g., scorecard of json1 vs json2) |
| prompt | string | yes | Analysis instructions — what to focus on |
| mode | integer | no | 0=instruction-only (default), 1=full prompt to LLM |
| domain | string | no | Industry/domain context |

**Pipeline:** Composer internally runs Legacy (203) + Customer (15) reports on each input graph, plus Quick Opportunities (300) on the third graph if provided, then synthesizes everything into a styled HTML strategic document.

**Response:** Full HTML document (Content-Type: text/html).

---

## DigitalTwinStorage

Store and retrieve competency profiles.

### AddToTwin
**POST** `/DigitalTwinStorage/AddToTwin`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| map_url | string | yes | Graph URL to store as twin |
| label | string | no | Label for the profile |

### GetTwin
**POST** `/DigitalTwinStorage/GetTwin`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| twin_id | string | yes | The twin ID to retrieve |

### GetSecureShareLink
**POST** `/DigitalTwinStorage/GetSecureShareLink`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| twin_id | string | yes | The twin ID to share |

---

## DeepGraph JSON Structure (Schema v1.0.3)

All graph endpoints return this structure:

```json
{
  "info": {
    "build": {
      "algorithm": "headai_v...",
      "build_date": "YYYY-MM-DD"
    }
  },
  "data": {
    "unique_identifier": "abc123",
    "legends": {
      "1": "Group Name"
    },
    "nodes": [
      {
        "id": 0,
        "label": "Concept Name",
        "weight": 3,
        "value": 42,
        "unique_value": 15,
        "group": "1",
        "search_center": false
      }
    ],
    "edges": [
      {
        "from": 0,
        "to": 1,
        "value": 24,
        "title": "concept_a - concept_b"
      }
    ],
    "scores": {},
    "indicators": {},
    "sources": []
  }
}
```

### Important notes:

- **Edges live in `data.edges[]`** — this is the canonical and required location. `relations[]` on nodes is optional and typically empty.
- **Node IDs are integers** (0-based sequential), not strings.
- **Edge value is a co-occurrence count** (integer), not a 0-1 score. Higher = stronger/closer relationship.
- **group** maps to `data.legends{}` — it's a visualization tag, not a semantic cluster.
- **weight** ranges: documented as 1-5, but 1-10 has been observed in actual API output.
