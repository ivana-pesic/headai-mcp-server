---
name: headai-api
description: >
  Connect to Headai's Core Engine APIs to build knowledge graphs, extract keywords, compare skills, get recommendations, and analyze trends. Use whenever the user wants to: analyze text with Headai, compare documents/CVs/curricula (Scorecard), get recommendations (Compass), translate or merge graphs, build trend signals, or work with digital twins. Trigger on: TextToGraph, BuildKnowledgeGraph, Scorecard, Compass, Headai API, megatron, knowledge graph, skill gap, curriculum-vs-market, workforce intelligence, Junior reports, Composer reports, graph analysis. If the user pastes a job description, CV, or any text for Headai processing, use this skill. ALWAYS use even for simple graph operations — contains critical guardrails preventing wasted API calls and wrong parameters.
---

# Headai API Skill

This skill gives you direct access to Headai's Core Engine — the AI that powers knowledge graphs, skill matching, gap analysis, workforce intelligence, and analytical reporting.

## How to Call the APIs

**Use the MCP tools** — they handle auth and async polling automatically. Do NOT use curl.

| MCP Tool | Endpoint | Purpose |
|----------|---------|---------|
| `headai_text_to_graph` | TextToGraph | Text → knowledge graph |
| `headai_text_to_keywords` | TextToKeywords | Text → weighted keywords |
| `headai_build_knowledge_graph` | BuildKnowledgeGraph | Dataset → knowledge graph (async) |
| `headai_scorecard` | Scorecard | Compare two graphs → gap analysis |
| `headai_compass` | Compass | Profile → recommendations |
| `headai_join_graphs` | JoinKnowledgeGraph | Merge 2+ graphs (URLs or JSON objects) |
| `headai_modify_graph` | ModifyKnowledgeGraph | Filter/refine a graph |
| `headai_translate_graph` | TranslateKnowledgeGraph | Translate graph language (URL or JSON object) |
| `headai_build_signals` | BuildSignals | Trend analysis (async) |
| `headai_digital_twin` | DigitalTwinStorage | Store/retrieve profiles |
| `headai_fetch_graph` | Fetch | Retrieve graph by URL |
| `headai_fetch_and_save` | FetchAndSave | Fetch + save locally |
| `headai_run_analyst` | run-junior (GET) | Run analytical report on graph/scorecard/signals |
| `headai_run_composer` | composer (POST) | Generate full strategic Composer report |
| `headai_get_jobs_by_text` | GetJobsByText | Search jobs by text |
| `headai_autocomplete_industry` | AutocompleteIndustry | Industry name lookup |
| `headai_autocomplete_job_title` | AutocompleteJobTitle | Job title lookup |
| `headai_industry_relations` | IndustryRelations | Industry → related industries |
| `headai_job_title_relations` | JobTitleRelations | Job title → related titles |

**Critical constraint:** Megatron has **2 cores per API key**. Only 1 Compass call at a time (MAX_CONCURRENT_COMPASS=1). Don't launch parallel heavy async calls — they will lock both cores and make the API key unusable.

**NEVER use `high_privacy_mode: true`** — it breaks downstream workflows (graph URLs become unusable for chaining into Scorecard, Compass, etc.).

For full parameter details, read `references/api-reference.md`.

---

## Decision Logic — Which Method to Use

This is the most important section. Choosing the wrong method wastes API calls and gives misleading results.

### Method Selection

| Method | Purpose | Requires | Focus |
|--------|---------|----------|-------|
| **Snapshot** (BKG) | Capture current state | 1 dataset + search_text | What's there now |
| **TextToGraph** | Parse user's own text | Free text input | Direct parsing |
| **Score** (Scorecard) | Compare & find gaps | 2 snapshots + **explicit comparison intent** | Differences |
| **Signals** (BuildSignals) | Detect trends | 2+ chronological snapshots (ascending time series) + **explicit change intent** | Time evolution |
| **Compass** | Recommend next steps | skills/interests + **explicit recommendation intent** | Actions |

### Method Ordering (Fixed)

```
1. Snapshot (one or more) → 2. Score or Signals → 3. Compass (optional, always last)
```

Never skip steps. Compass needs input from earlier steps to produce meaningful recommendations.

### Intent Triggers

Detect user intent from these patterns:

- **Snapshot:** osaamistarve, osaamiskartta, tilannekuva, nykytila, "what skills are needed", "show me the landscape"
- **Score:** vertaa, vertailu, katve, puute, gap, "what's missing", "differences between", "compare"
- **Signals:** muutos, kehitys, trendit, ennuste, foresight, "how has it changed", "what's trending"
- **Compass:** suositukset, zpd, "how to fill gaps", "what next", "recommend"

### Critical Rule: Time Reference ≠ Signals

A year in the query does NOT automatically mean Signals. Look for *change* language:
- "osaamistarve 2025" → **Snapshot** (state for a year)
- "osaamistarpeen muutos 2025" → **Signals** (change over time)

### Guardrails

1. **No Guessing**: If information is missing, ask — never assume
2. **Explicit Intent**: Only use a method if user intent explicitly supports it
3. **Conservative Fallback**: When in doubt → Snapshot
4. **Two snapshots alone ≠ Scorecard**: Must have explicit comparison/gap intent
5. **predict=true only on explicit forecast request**

---

## Search Text Rules (for BuildKnowledgeGraph)

The `search_text` parameter determines what the snapshot captures. Getting it right is critical:

- Contain **exactly 20 domain-specific keywords** (comma-separated)
- **Never** use the legend text as search_text
- Use **domain-specific vocabulary** matched to the dataset:
  - `job_ads` → operational labour market language (e.g., "ohjelmistokehittäjä, pilvipalvelut, DevOps")
  - `doaj_articles` → research/conceptual language (e.g., "machine learning, neural networks, NLP")
  - `curriculum` → institutional/regulatory language (e.g., "opetussuunnitelma, osaamistavoitteet")
- **No generic cross-industry terms** like "experience", "skills", "collaboration"
- Use the **same language** as the user's prompt
- Hyphens = AND logic, commas = OR logic (e.g., "environment-and-energy,digital-and-energy")

---

## Datasets & Ontologies

### Datasets

| Dataset | Horizon | Geo Filters | Notes |
|---------|---------|-------------|-------|
| `job_ads` | Present/history | country, city | Finnish + EU job ads (TMT, Duunitori, MOL, Eures) |
| `curriculum` | Education | country, city | Finnish HEI curricula (Metropolia, Aalto, TUNI, etc.) |
| `theseus` | Education | affiliation | Finnish theses |
| `doaj_articles` | 5-10yr future | affiliation | Always language="en" |
| `investment_data` | 1-3yr future | — | Research signals |
| `news` | Current events | — | Multi-source news (BBC, YLE, Guardian, TechCrunch, etc.) |
| `imported`/`custom` | N/A | — | Customer data |
| `jobs_by_company_name` | Present | — | Jobs by company |

Key constraints: `country` and `city` are mutually exclusive. `affiliation` only for doaj_articles/theseus. Default size=200; use 500-1000 for city-level analysis. Data from 2015 onward.

### Ontologies

| Ontology | Terms (en) | Status | Notes |
|----------|-----------|--------|-------|
| `headai` | 168,833 | **Default, richest** | Also 75,636 Finnish terms |
| `esco` | 136,175 | **Working** | 67,684 Finnish terms |
| `lightcast` | 33,078 | Working | Only one supporting `additional_data=true` |
| `headai_optimized` | 54,124 | Working | Curated subset of headai |
| `yso` | 0 | **BROKEN — DO NOT USE** | 0 terms indexed |
| `fibo` | Unknown | Untested | Financial domain |

---

## Compass Namespaces (Use EXACT names)

Namespace names must be used exactly as listed — "Udemy" won't work, use "inokufu udemy".

### Education / Courses
| Namespace | Source | Items |
|-----------|--------|-------|
| `metropolia` | Metropolia UAS | 23,432 |
| `Tuni` | Tampere University | 23,187 |
| `Aalto University` | Aalto University | 21,515 |
| `University of Helsinki` | University of Helsinki | 34,605 |
| `University of Jyvaskyla` | JYU | 18,685 |
| `XAMK` | South-Eastern Finland UAS | active |
| `TuAMK` | Turku UAS | active |
| `LUT` | LUT University | active |
| `Laurea` | Laurea UAS | active |
| `TAMK` | Tampere UAS | active |
| `HAMK` | Häme UAS | active |
| `koulutusfi` | koulutus.fi (all Finnish) | aggregator |
| `linkedin_learning` | LinkedIn Learning | confirmed |
| `moncompteformation` | French national catalog | 109,132 |
| `inokufu udemy` | Udemy via Inokufu | 55,978 |
| `inokufu coursera` | Coursera via Inokufu | active |
| `classcentral` | Class Central | 19,927 |
| `classcentral_ai` | AI-specific courses | active |
| `any` | All sources | aggregator |

### Jobs
| Namespace | Description |
|-----------|-------------|
| `TMT` | Työmarkkinatori (Finnish labour exchange) |
| `Duunitori` | Finnish job board |
| `MOL` | Finnish employment services |
| `Eures` | EU-wide jobs portal |
| `kuntarekry` | Finnish municipal jobs |
| `valtiolle` | Finnish government jobs |
| `any` | All job sources combined |

### Compass Request Modes
| Mode | Purpose | Use with |
|------|---------|----------|
| `match` | Best skill overlap | courses + jobs |
| `zpd` | Zone of Proximal Development (stretch goals) | courses + jobs |
| `demand` | Market demand-based ranking | courses |
| `jobs` | **REQUIRED** for job namespaces | jobs only |
| `companies` | Company recommendations | jobs |
| `curriculum` | Curriculum matches | courses |
| `researcher` | Research opportunities (EN) | research |

Can combine modes: `["match", "zpd", "demand"]` or `["jobs", "match"]`

---

## DeepGraph Response Format (Schema v1.0.3)

### Top-Level Structure

```
{ info: {...}, data: { unique_identifier, legends, nodes[], edges[], indicators?, scores?, sources? } }
```

### Nodes

| Field | Required | Description |
|-------|----------|-------------|
| id | yes | Sequential, 0-based integer |
| label | yes | Concept text |
| value | yes | Frequency count across documents |
| weight | no | Specificity (1-5 documented, 1-10 observed). Higher = more specialized |
| unique_value | no | Distinct document count |
| group | yes | Maps to `legends{}` — visualization tag |

### Edges — `data.edges[]` is the ONLY reliable edge location

`relations[]` on nodes is optional and typically empty in API output. Always read edges from `data.edges[]`.

```json
{"from": 0, "to": 1, "value": 24, "title": "concept_a - concept_b"}
```

- **value**: Co-occurrence count (integer). Higher = stronger/closer. Ranges: TextToGraph 1-25, Scorecard 1-373+
- **title**: Present in TextToGraph/BKG, absent in Scorecard edges

### Group Semantics

**Scorecard** always has exactly 3 groups: 1=Common, 2=Left only, 3=Right only.

**Signals** has up to 8 groups: 1=Emerging, 2=Constantly Increasing, 3=Increasing in last Map, 4=Constant value, 5=Constant in last Map, 6=Constantly Decreasing, 7=Decreasing in last Map, 8=Disappearing.

### BuildSignals — Time Series Analysis (Detailed)

BuildSignals takes an **ascending time series** of 2 or more knowledge graph snapshots and produces a signals analysis showing how concepts change over time.

**Core concept:** You give it a series of snapshots (e.g., skills demand in 2020, 2022, 2024) and it computes change maps between each pair, classifying every concept into one of the 8 signal groups above.

**Parameters:**
- `urls`: Comma-separated graph URLs in **ascending chronological order**. Minimum 2.
- `map_legends`: Comma-separated labels, one per URL. Two modes:
  - **predict=false** (default): Labels can be any free text — "Labor Market,Investments,Research" or "Q1,Q2,Q3" or "2022,2023,2024"
  - **predict=true**: Labels **MUST be year numbers** in ascending order — "2020,2022,2024". The system extrapolates a prediction for the next period.
- `predict`: Boolean. When true, generates a prediction map for the next time period.
- `dataset`: "doaj", "job_ads", or "custom". Controls auto-title generation. Use "custom" for user-provided graphs.
- `title`: Base title for the series — combined with dataset to generate per-map titles.

**Output structure:** The result `data[]` array contains alternating entries:
1. Original snapshot (buttonTitle = legend label, hideLegend=true)
2. Change map between snapshots (buttonTitle = ">", shows signal groups)
3. Next snapshot... and so on
4. If predict=true: final entry is the prediction map

Each change map is a standard DeepGraph where node groups indicate the signal direction (1-8).

**Visualization:** `https://megatron.headai.com/mapSeries.html?json_url=<result_url>`

**Workflow example:**
1. Build 3 snapshots: BKG("data science", 2020), BKG("data science", 2022), BKG("data science", 2024)
2. BuildSignals(urls=url1,url2,url3, map_legends="2020,2022,2024", predict=true, dataset="custom", title="Data Science Trends")
3. Run Analyst report 400 (Signal Quick Opportunities) on the result for structured insights
4. Or run specific signal reports: 401 (Emerging hubs), 406 (Decline watch), 408 (Opposing forces)

**Important notes:**
- All input graphs must be **ready** (fully built) before calling BuildSignals
- 3+ snapshots recommended for robust trends, but 2 works for basic comparison
- The prediction feature extrapolates linearly — more data points = better prediction
- Signal Analyst reports (400-408) must be run on the **top-level BuildSignals URL** (not on individual change maps)
- Individual change maps in the output are NOT standard graphs — regular graph reports (1-15) won't work on them
- 3+ snapshots needed for signal reports to find "constantly increasing/decreasing" patterns (groups 2,6)

### Scorecard Extra Fields

- `data.scores`: full_score, full_score_normalized, important_topics_score, important_topics_found[], important_topics_missing[]
- `data.indicators`: data_quality_factor, data_size_balance, meaningful_words_count
- `data.sources`: [{id, title, url}]

---

## Analytical Reports (Analyst & Composer)

The Headai system includes powerful analytical sub-reports that can be run on graph, scorecard, or signals output via `headai_run_analyst` (GET endpoint at qa.headai.com:8081/run-junior) and `headai_run_composer` (POST endpoint at qa.headai.com:8081/composer). These are the report types:

### Graph Reports (run on knowledge graphs)
| ID | Name | What it finds |
|----|------|---------------|
| 1 | Most connected concepts | Ego1 clusters ranked by score |
| 3 | Most significant group | Highest-score ego1 cluster |
| 4 | Top groups by total weight | Top N clusters by score |
| 5 | Weakest groups | Bottom clusters (size≥5) |
| 6 | Strongest concept pairs | Strongest edges |
| 7 | Strongest bridging concepts | Nodes connecting clusters |
| 8 | Hidden strengths | degree=1, weight>2 — underutilized strong concepts |
| 9 | Wide but weak | degree≥5, weight≤1 — overextended concepts |
| 10 | Outlier concepts | weight>3 in small clusters |
| 15 | Customer Strategic Report | Key findings (LLM-powered) |
| 999 | Data Insight Report | Top N strategic topics by composite score |

### Scorecard Reports (run on scorecard output)
| ID | Name | What it finds |
|----|------|---------------|
| 300 | Quick Opportunities | Full composite: 305,302,303,309,308,301,304,306,307 |
| 301 | Strongest common concepts | Top concepts shared by both sides |
| 305 | Cross-group hub concepts | Concepts bridging the gap |
| 308 | Low-hanging fruits | Easiest shared opportunities |
| 309 | Gap report | Capacity vs lack between groups |

### Signal Reports (run on signals output)
| ID | Name | What it finds |
|----|------|---------------|
| 400 | Signal Quick Opportunities | Full composite: 401-408 |
| 401 | Emerging hubs | Where emerging concepts cluster |
| 406 | Decline watch | Sustained decrease signals |
| 408 | Opposing forces | Emerging meets Disappearing |

### Composite/Strategic Reports
| ID | Name |
|----|------|
| 100 | Legacy Overview (2, 3, 4, 7, 8) |
| 102 | Strategic Overview Report |
| 200 | Full Legacy Report (1-14 with LLM noise removal) |
| 600 | Composer Report — full strategic document |

### Key Formulas (for programmatic analysis)

**Signal3** (node importance): `0.7 × weight + 0.3 × log(1 + value)`

**Strategic Score** (Reports 15/999): `0.35 × (value/max) + 0.25 × (uniqueValue/max) + 0.25 × min(weight/5, 1) + 0.15 × (connections/max)`

**Default ranking**: weight → degree → strength → value (all descending)

---

## Visualization

Graph URLs from Headai can be visualized using the public visualizer:

```
https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=<graph_url>
```

Replace `<graph_url>` with the full URL returned by any graph-producing endpoint.

---

## Language & Translation

1. Determine the user's language (fi/en/sv)
2. Set API `language` to match the dataset (e.g., doaj_articles always = "en")
3. Add `headai_translate_graph` ONLY if source ≠ target language
4. Never add speculative translations
5. Supported translation targets: BG, CS, DA, DE, EL, EN, ES, ET, FI, FR, HU, ID, IT, JA, LT, LV, NL, PL, PT, RO, RU, SK, SL, SV, TR, UK, ZH

---

## Presenting Results to Users

- **Don't dump raw JSON** — summarize insights in natural language
- Focus on **high-weight, high-value concepts** (the most meaningful ones)
- Report **edge statistics**: count, value range, top strongest connections
- For **Scorecards**: report coverage score, highlight common concepts (group 1), unique to each side (groups 2 & 3), and important_topics_found vs missing
- For **Signals**: highlight emerging (group 1) and disappearing (group 8) concepts
- Graph URLs from one endpoint can be fed into others: build → score → compass
- Offer the **Visualizer link** for interactive exploration

## Tips

- Large texts (>5000 chars) work fine with TextToGraph, may take 10-20 seconds
- `word_type: "only_compounds"` for precise multi-word terms, `"none"` for all words (broad results)
- BKG date fields (search_year, search_month, search_day) accept **integers** — e.g. `search_year: 2025, search_month: 3, search_day: 0`
- JoinGraphs and TranslateGraph accept both URLs and JSON objects as input — use objects when you already have the graph in memory
- Language codes: en, fi, sv, de, fr, es, it, nl, da, no, pt, et, lv, lt
