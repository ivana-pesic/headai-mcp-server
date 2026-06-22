# Changelog

All notable changes to the Headai MCP Server are documented in this file.

Server: **mcp.headai.dev** | Hosting: **Railway** (auto-deploy from GitHub main)

---

## [1.4.5] - 2026-06-22

### Changed
- **`text_to_graph` upgraded to v2 engine.** Endpoint now calls `/v2/TextToGraph` with three new parameters: `group_plurals` (boolean, merges singular/plural forms), `enable_semantic_cleaning` (boolean, removes semantically redundant nodes), and `keyword_type` (replaces the old `word_type`). All existing parameters continue to work. Token data lookup updated to match the v2 endpoint name.

---

## [1.4.4] - 2026-06-11

### Changed
- **Index volumes are no longer presentable as statistics.** Server instructions, the playbook guardrails, and the estimate_size description now state explicitly: counts returned by Headai tools are index volumes (documents in the corpus matching a query), not official labor-market statistics — agents must not present them as "number of open jobs" and should route official-count questions to national statistics services (e.g. Statistics Finland). Headai's value is framed as semantic: what is inside the demand — skills, patterns, signals, trends — in comparable units over time. (Positioning correction from product: counting jobs is statistics; reading ten years of them is Headai.)

---

## [1.4.3] - 2026-06-11

### Changed
- **jobs_by_company_name downgraded to experimental** pending verification — live testing on the v2 engine produced a semantic-cleaning failure ("status: completed" with an error message and 0 nodes — also an upstream status-reporting bug worth fixing in Megatron) and a 225s+ queue on retry. The dataset remains accepted, but agent guidance now points to the two verified company paths: get_jobs_by_text with the company name as search, and job_ads builds with the company name in search_text.

---

## [1.4.2] - 2026-06-11

### Fixed
- **get_jobs_by_text no longer crashes when keywords is empty.** Megatron throws StringIndexOutOfBoundsException (-2) at jobs_educations_snowflake.java:185 when the keywords parameter is empty — exactly what happens when an agent searches by company name ("Nokia") without skills. The MCP now falls back to using the search terms as keywords, and rejects calls where both search and keywords are empty with an actionable message. (Upstream fix still desirable — reported.)
- **Company-name job search documented and enabled.** Verified live: get_jobs_by_text with a company name as search returns that company's listings (results carry a company field). Exposed the upstream `jobs_by_company_name` BuildKnowledgeGraph dataset (search_text = company names, for competitor hiring graphs) — it exists in the Megatron API reference but was missing from the MCP dataset list (and would have been rejected by 1.4.0's dataset validation). Server instructions now state company-level job search IS supported, so agents stop claiming otherwise.

---

## [1.4.1] - 2026-06-11

### Fixed
- **job_ads historical archive documented** — agents were hallucinating that job_ads is "a rolling window of currently-open postings with no archive" (observed in a Lovable build session) because the docs only said "no search_year needed." Tool description, playbook, and server instructions now state the archive reaches back to 2015 and that search_year/startDate-endDate are optional and fully supported for retrospective and multi-year signals analysis (verified: fi marketing 2018 = 520 ads, 2024 = 1,089 ads).
- **"Namespaces" jargon removed from user-facing guidance** — compass and career_navigator descriptions now call them "training providers / course catalogs" (API parameter names unchanged), and the server instructions tell agents to use plain language with end users — never internal terms like namespace, ontology code, or report number. Observed: an orchestrator asked an end user "Training namespaces — default is Laurea + Stadin... Preference?"

---

## [1.4.0] - 2026-06-11

### Changed
- **Graph-producing tools no longer dump raw JSON.** `join_graphs`, `modify_graph`, `translate_graph`, and `digital_twin get` now return the standard compact shape (`status` + persistent `graph_url` + `summary` + tip) via a shared `graphOperationResponse` helper — same URL-recovery logic as text_to_graph (initial job location, then retried token-data lookup). Raw JSON remains available via `headai_fetch_graph`. Previously join_graphs regularly hit the response truncation limit and returned no chainable URL at all.
- **Server-level MCP `instructions` added** — chaining order, sequential-build guardrail, dataset/year requirements, and the scorecard compatibility guardrail now reach every client automatically at connection time instead of relying on the agent calling `get_playbook`.
- **Single `SERVER_VERSION` constant** — McpServer registration (was stale at "1.0.0"), health endpoint, and analytics all read one constant now.

### Fixed
- **Dataset names: v1 and v2 spellings both accepted everywhere.** `investment_data`/`investments` and `doaj_articles`/`doaj` are normalized automatically in build_knowledge_graph_v2, estimate_size, and the preview pre-flight; unknown datasets fail fast with the valid list. Previously the same dataset needed different names in estimate_size vs BKG v2 — a reliable agent trap.
- **estimate_size validates year-required datasets** (doaj, investments, news, tiedejatutkimus) with an actionable error instead of returning a confusing `-1`.
- **BKG v2 preview pre-flight no longer reports a false "estimate_size check failed"** — it was POSTing to a nonexistent `/estimate_size` endpoint; now uses the same `GET /Utils?action=BuildKnowledgeGraph_estimate` call as the estimate_size tool (with v1 dataset name).
- **`modify_graph` max_nodes now keeps the heaviest nodes.** Megatron's own `max_nodes` truncates by node insertion order, which silently kept first-source low-weight nodes and dropped second-source weight-10 nodes. The MCP now translates `max_nodes` into a weight threshold computed from the actual graph (falls back to engine behavior with a warning note only when ties make a weight cut impossible). Also fixed the `weight` docs — graph weights range 1-10, not 1-5.
- **`career_navigator` `match_score` is no longer null** — the scorecard JSON has no `match_score` field, so the same shared/(shared+gaps) percentage that scorecard_v2 reports is now computed from group counts.
- **`build_signals` results summarize properly** — the summarizer now understands the signals result shape (a collection of sub-map links + time labels) instead of returning an empty string.
- **estimate_size drops the misleading `estimated_time` field** (it referred to a hypothetical full-corpus build, not the query).
- **get_jobs_by_text maps the year-2650 "no deadline" sentinel** in `end_date` to `"open"`.
- **Playbook/description contradictions resolved:** `update` documented as boolean force-rebuild (was described as incremental-add-by-URL in the playbook); `word_type` "none" removed from text_to_graph (leave empty for all words); keyword-count guidance aligned (~20-40).

### Documented
- **Digital Twin deletion gap:** the upstream DigitalTwinStorage API has no delete endpoint (verified against the API reference — only AddToTwin/GetTwin/GetSecureShareLink). Noted in the tool description; tracked as a Megatron feature request. NOTE: the privacy policy currently states twin data "can be deleted via the API" — wording or upstream capability needs reconciling.
- twin_key guidance now recommends opaque IDs over email addresses (keys appear in share URLs and logs).

---

## [1.3.8] - 2026-06-11

### Fixed
- **`text_to_graph` no longer loses the persistent `graph_url`.** Three failure paths fixed: (1) the initial response's `location` (which is the persistent result URL) is now captured before polling — `pollUntilReady` returns the final graph data without it; (2) synchronous inline completions (short texts) now recover the URL via a token-data lookup with up to 3 retries (~7.5s) — Megatron writes the row a few seconds after completion, and the previous single instant lookup always lost the race; (3) the lookup now matches the row to the call (legend/text prefix) instead of blindly taking the newest item.
- **`scorecard_v2` now polls internally when the job queues.** Megatron's initial response can be `{status:"work in progress", location, current_position}` instead of `{status:"success", url}` — the old gate only accepted the latter, so queued scorecards returned the raw in-progress JSON to the client despite the "no external polling needed" promise. Polling now starts whenever a result URL is present in either shape.
- **Startup self-test no longer logs a false `403` health error on every boot.** The reachability ping treats any HTTP response (including a WAF 403 on a bare unauthenticated GET from the Railway egress IP) as proof Megatron is up — only network-level failures count as unreachable. API-key validation failures are now logged distinctly as non-fatal and no longer abort the remaining checks.

---

## [1.3.7] - 2026-06-10

### Fixed
- **`search_year` no longer silently overrides `startDate`/`endDate`.** Megatron treats them as mutually exclusive with search_year winning — two "different" quarters built with the same search_year returned 100% identical sources (verified in cyber media-tracking run). The MCP now omits search_year/month/day from the payload whenever a date range is set, the preview shows the date range (with a conflict warning when both were supplied), and the year requirement for news/doaj/investments/tiedejatutkimus is waived when a range is present. Schema texts updated to stop instructing the conflicting combo.
- **Media-tracking prompt templates (EN + FI) used strict quality settings for entity tracking** — `focused_build: true` + default `only_compounds` on pure entity-name lists, the exact combo 1.3.6 documented as returning near-empty news graphs. Templates now instruct `focused_build: false` + `word_type: "all"` and explicitly forbid search_year alongside the quarter date ranges.

---

## [1.3.6] - 2026-06-10

### Fixed
- **News dataset entity-tracking guidance** — the recommended strict combo (`word_type="only_compounds"` + `focused_build=true`) returns near-empty graphs for entity/mention tracking on news (verified: fi "Tampere" 2025 → 1 node strict vs 73 nodes / 165 edges with `word_type="all"` + `focused_build=false`). News prose contains few ontology-matching compounds; focused_build then prunes everything weakly connected to the seed. Added:
  - News-dataset exception in the BKG v2 tool description and playbook (entity tracking → `word_type="all"`, `focused_build=false`, noise_list for incident vocabulary)
  - Preview-gate warning when news + ≤3 search terms + strict settings are combined
  - Preview-gate warning that news does not support city/country filtering (parameter recorded but not applied — scope via search_text)
- Investigation note: the suspected "silently dropped city param" was not real — `list_token_data` shows city recorded (param9); the 0-node result came from 2026 news being empty.

---

## [1.3.5] - 2026-06-10

### Fixed
- **Privacy policy corrected to match actual data handling** (OpenAI submission compliance): the "stateless / API key not stored" claims were outdated since 1.3.1 (Redis session storage, 24h TTL) and 1.2.11 (usage analytics, 90-day TTL). The policy now discloses session credential caching, aggregated usage statistics, and Digital Twin profile storage, with retention timelines for each.
- **Removed directive language from tool descriptions** (crept back after 1.2.2's marketplace cleanup): scorecard_v2 "CRITICAL/ALWAYS/Do NOT" rephrased factually; build_signals "NO confirmation gate" rephrased. Same behavioral guidance, plain language.
- **Health endpoint version/tool-count constants corrected** (1.3.3 → 1.3.5, tools 25 → 23).

---

## [1.3.4] - 2026-06-10

### Fixed
- **Corrected MCP tool annotations on 13 of 23 tools to match actual behavior** (OpenAI Apps SDK review rejection fix):
  - `openWorldHint` → `false` on all 23 tools. Per OpenAI's review criteria, `true` is reserved for tools that can change publicly visible internet state. All Headai tools operate against the first-party API with private, token-scoped artifacts.
  - `readOnlyHint` → `false` on `text_to_graph`, `text_to_keywords`, `career_navigator`, `foresight_agent` — they create stored artifacts under the API token.
  - `idempotentHint` → `false` on all artifact-creating tools (`scorecard_v2`, `join_graphs`, `modify_graph`, `translate_graph`, `digital_twin`, and the four above) — each call creates a new stored artifact.
  - `fetch_and_save` → `readOnlyHint: false`, `destructiveHint: true` — it writes to the server container filesystem and silently overwrites existing files at `save_path`.
- Added per-tool annotation rationale comments in `src/index.ts` (also used as justifications in the OpenAI resubmission — see `openai-resubmission-notes.md` in the project folder).

---

## [1.3.3] - 2026-06-09

### Fixed
- **Removed diacritics normalization that broke Finnish programme name matching.** The v1.3.2 `normalizeFieldScoping` function stripped diacritics from field-scoped values (ä→a, ö→o), assuming the curriculum index uses ASCII. It doesn't — Megatron stores original Finnish characters. `programme:Tieto- ja viestintätekniikka` (with ä) returned 231 nodes; the normalized `programme:tieto- ja viestintatekniikka` (with a) returned 0. The function now passes values through as-is, only trimming whitespace.

---

## [1.3.2] - 2026-06-09

### Fixed
- **BKG v2 cross-type field scoping (school:X,programme:Y) now returns real results instead of 0 nodes.** Root cause: `word_type: "only_compounds"` was always sent to Megatron, even for field-scoped queries. This parameter breaks Megatron's cross-type AND logic — `school:SAMK,programme:Tieto- ja viestintätekniikka` returned 0 nodes with it, 231 nodes without it.
- When field scoping is detected in `search_text` (school:, programme:, title:, description:, curriculum: prefixes), the MCP now omits `word_type`, `enable_semantic_cleaning`, and `analyze` from the payload. Megatron uses its own server-side defaults, which handle field scoping correctly.
- Preview gate updated to show when field scoping bypass is active instead of suggesting `word_type="only_compounds"` for field-scoped queries.

---

## [1.3.1] - 2026-06-09

### Fixed
- **MCP sessions now survive Railway redeploys.** Previously every deploy wiped the in-memory `transports` and `sessionApiKeys` maps, which silently broke every active Claude.ai / ChatGPT / Copilot connection — the client kept sending requests with its cached `mcp-session-id`, the server returned 400 "No valid session ID provided", and tools just stopped working until the user disconnected and reconnected.
- `sessionApiKeys` is now backed by `PersistentMap("session:apikey", 86400)` — Redis-persisted, 24h TTL refreshed on activity.
- When a stale `mcp-session-id` arrives, the server looks the API key up in Redis, builds a fresh `StreamableHTTPServerTransport` bound to the **same** sid, pre-flips the SDK's internal `_initialized` flag to skip the handshake, and processes the request transparently. Client never sees a session drop.
- Stale sessionId without a cached key now returns `-32004 "Session expired or not found. Please re-initialize."` instead of generic `-32000 "Bad Request"` — gives well-behaved clients a clearer signal to re-init.
- Health endpoint version string corrected from stale `1.2.11-analytics` to `1.3.1`.

### Why this matters
- Pre-fix: every push to `main` triggered Railway redeploy → all Claude.ai users had to manually reconnect (re-paste API key) to get tools working again.
- Post-fix: redeploys are invisible to clients. Same `mcp-session-id` works through any number of pod restarts within the 24h TTL window.
- Connection survives because OAuth tokens were already persisted (1.2.10), and now MCP sessions are too.

---

## [1.3.0] - 2026-06-09

### Fixed
- **Scorecard v2 polling now handles all Megatron status strings** (calculating, processing, queued, pending, running). Fixes the TextToGraph-vs-BKG comparison path through the MCP that was failing with "unknown status" before.
- Unknown polling statuses continue polling instead of returning an error; error status gets one second-chance graph fetch before giving up.
- Annotations corrected on 6 write tools (BKG v2, Scorecard v2, Signals, Join, Modify, Translate) — `readOnlyHint` changed from `true` to `false`. Required for ChatGPT App Store resubmission.

### Changed
- `headai_run_analyst` reorganized into 5 priority tiers (Overview → Deep → Scorecard → Signal → Comprehensive) with suggested chains.
- Playbook trimmed from 5500 to 1300 chars — removed behavioral instructions, kept the factual reference only.

### Added
- Guardrail: `scorecard_v2` documentation explicitly states it can compare **any two graph types**, preventing the LLM from hallucinating format incompatibility.
- Guardrail: curriculum queries must use BKG with `school:` field scoping, not `text_to_graph`.

---

## [1.2.12] - 2026-06-02

### Removed
- **v1 tools removed from the MCP surface** — `headai_build_knowledge_graph` and `headai_scorecard` (v1) are gone. Only the v2 engines remain (`headai_build_knowledge_graph_v2`, `headai_scorecard_v2`). v1 was already deprecated and v2 fully replaces both graph building and scoring. Tool count: 23.

### Changed
- **Default build size is now 100** (was 300) on `headai_build_knowledge_graph_v2` — faster and cheaper by default. Larger sizes (300 quality, 500 deep) are used only when the user explicitly asks for a stronger build.
- **Analysis algorithms reframed** — `headai_run_analyst` and the public API docs no longer surface internal report numbers or "Junior" terminology. Algorithms are named by purpose (gap analysis, quick wins, hubs, emerging/fading trends, quality score, …); numeric codes remain only as the call mechanism and are never shown to end users.

### Deprecated
- **SDG-preset scoring** was a v1-Scorecard-only feature and is deprecated with the v1 removal. The SDG mapping playbook now uses Scorecard v2 as a best-effort semantic match.

---

## [1.2.11] - 2026-05-27

### Added
- **MCP usage analytics** — Lightweight Redis-based telemetry tracking platform breakdown (Claude, ChatGPT, Copilot, etc.), tool popularity, session volume, and unique API key cardinality. Fire-and-forget design — analytics never blocks or crashes the MCP server. All data stays in private Redis with 90-day TTL.
- **Analytics dashboard** — Self-contained HTML dashboard at `/analytics/dashboard` with KPI cards, platform bars, tool ranking, daily table, and recent event stream. Dark theme, no external dependencies.
- **Analytics API** — JSON endpoint at `/analytics?days=N` for programmatic access. Both endpoints require Bearer token authentication — no anonymous access.

## [1.2.10] - 2026-05-27

### Added
- **Redis token persistence** — OAuth client registrations and auth codes now survive Railway deploys. Uses `ioredis` with Railway's internal Redis addon (`REDIS_URL` env var). Graceful fallback to in-memory if Redis is unavailable — zero risk of breaking existing behavior. Health endpoint now reports `redis: "connected"` or `"unavailable"`.

### Fixed
- **OAuth token-wipe-on-deploy** — Previously, every Railway deploy wiped all in-memory OAuth client registrations, causing connected users (Claude, ChatGPT, Copilot) to get silent errors until they reconnected. With Redis persistence, registered clients survive restarts. This was a marketplace submission blocker.

## [1.2.9] - 2026-05-27

### Added
- **Media tracking prompt templates** (`bea07f8`) — Two new MCP prompts available to all connected clients:
  - `headai-media-tracking` (English) — Track entities in news across 7 quarters, scorecard comparison, offers Sankey + network viz as follow-ups
  - `headai-mediaseuranta` (Finnish) — Same workflow in Finnish with Finnish-language noise list and corpus defaults
  - Both auto-calculate quarter boundaries, enforce sequential builds, and include domain-specific noise lists

## [1.2.8] - 2026-05-26

### Changed
- **Analyst reports now opt-in only** (`8d4316f`) — Removed mandatory "AFTER EVERY ANALYSIS: run_analyst" from both playbook sections. Analyst reports are now only triggered when user explicitly asks for deeper analysis. Saves ~30-50% tokens per conversation turn. Updated all 10+ example orchestrations and all prompt templates.

### Fixed
- **JoinKnowledgeGraphs array→string serialization** (`aaa03cf`) — LLMs send `urls` as JSON array but Headai API expects comma-separated string. Tool was completely non-functional via MCP. Schema now accepts both formats via `z.union([string, array])` with automatic normalization. Bug reported by Harri.
- **BuildSignals same array→string issue** (`aaa03cf`) — Applied same defensive fix to `urls` and `map_legends` parameters.

## [1.2.7] - 2026-05-26

### Added
- **Scorecard v2 tool** — New `headai_scorecard_v2` with automatic semantic matching (cosine similarity node merging), async execution, persistent result URLs, and richer scoring (full_score, important_topics_score, data quality indicators). Uses `/v2/Scorecard` endpoint. Preferred over v1 for graph-vs-graph comparisons.

### Fixed
- **Scorecard v2 internal polling** — Tool now polls the result URL internally for up to ~90 seconds instead of returning async "calculating" status. LLM clients no longer need to handle polling — the tool blocks until results are ready, just like v1 Scorecard.

### Changed
- **Playbook method table updated** — Score row now recommends `headai_scorecard_v2` (preferred) with v1 as fallback for text-based/SDG comparisons. Comparison flow example uses v2.

## [1.2.6] - 2026-05-26

### Changed
- **BKG v2 word_type defaults to "only_compounds"** — Single-word noise (e.g. "innovation", "applicant", "continue") eliminated by default. LLMs no longer need to specify this parameter — clean graphs out of the box.
- **Playbook enhanced with company query guidance** — Added COMPANY-SPECIFIC QUERIES section (Finnish language for Finnish companies, no year-filter on job_ads, estimate_size first, search_text strategy), MULTI-BUILD COMPARISONS (plan before building), and VISUALIZATION (no external links in workspace).

## [1.2.5] - 2026-05-25

### Added
- **Pre-seeded Teams Copilot OAuth client** — Hardcoded the Microsoft Teams / Copilot declarative agent OAuth client credentials in the `registeredClients` Map so they survive Railway restarts. Previously, dynamically registered clients were lost on every deploy. Client ID: `833df4c8-...`, redirect to Teams OAuth callback.

## [1.2.4] - 2026-05-25

### Fixed
- **ChatGPT cross-tool parameter leakage** — Removed `high_privacy_mode` from `text_to_graph` and `text_to_keywords` tool schemas (parameter was visible to LLMs, causing them to send it to BKG which doesn't support it → Zod validation errors). Added optional-ignored safety-net `high_privacy_mode` parameter to `build_knowledge_graph` and `build_knowledge_graph_v2` schemas so any cached LLM memory of the parameter won't crash. Internal server-side calls still pass the parameter to Headai API where it's supported.
- **Docs HTML cleanup** — Removed `high_privacy_mode` rows from text_to_graph and text_to_keywords parameter tables in built-in documentation.

### Added
- **OpenAI domain verification** (`702bdf8`) — Added `/.well-known/openai-apps-challenge` endpoint serving the verification token for ChatGPT Apps marketplace submission.
- **OAuth auto-registration for unknown clients** — `/oauth/authorize` and `/oauth/token` now auto-register unknown client_ids instead of rejecting them. Fixes "Unknown client_id" errors after server restarts when clients (like ChatGPT) cache DCR client_ids. PKCE code_challenge/code_verifier still protects the token exchange.

## [1.2.3] - 2026-05-25

### Added
- **OAuth 2.1 PKCE compliance** (`45b0396`) — Upgraded authorization flow from OAuth 2.0 to 2.1 with mandatory S256 PKCE. Public clients (like Claude Desktop) can now authenticate without client_secret by using code_verifier/code_challenge. Removed "plain" from supported challenge methods. Confidential clients still fall back to client_secret when no PKCE challenge is present.
- **Google Search Console verification** (`dcacbdc`) — Added verification HTML file for domain ownership proof, enabling indexing requests.

### Fixed
- **Complete favicon stack** (`5019465`, `2d5d996`, `7c0d742`, `4286065`) — Added multi-size PNG (16–512px), SVG favicon, web manifest, and apple-mobile-web-app-title. Ensures Google's favicon API and all browsers/platforms display the Headai logo correctly.

## [1.2.2] - 2026-05-24

### Changed
- **Marketplace-ready tool descriptions** (`8b79182`) — Removed all behavioral directives (ALWAYS/NEVER/CRITICAL/DO NOT) from tool description fields. Factual content preserved; orchestration logic remains in playbook response. Passes Anthropic's prompt-injection review criteria.
- **Origin header validation** (`8b79182`) — Added configurable Origin allowlist (MCP_ALLOWED_ORIGINS env var) with defaults for claude.ai, chatgpt.com, copilot.microsoft.com, headai.dev.
- **Softer error messages** (`8b79182`) — ERROR_SUFFIX changed from directive to factual note.

### Added
- **REVIEWER_GUIDE.md** (`8b79182`) — Step-by-step setup guide for marketplace reviewers with test API key, example scenarios, and architecture notes.
- **Title vs legend convention documented** (`8b79182`) — Added Headai naming convention to every parameter that accepts `legend` or `title` across 8 tools (`text_to_graph`, `build_knowledge_graph`, `build_knowledge_graph_v2`, `scorecard`, `join_graphs`, `modify_graph`, `build_signals`, profile/CV builder). Source: Harri Ketamo — when title is empty, legend acts as the canonical name; when both are set and differ, they refer to different entities with separate histories. Tool descriptions use factual prose (no CAPS directives) per the marketplace style established in `8b79182`.

## [1.2.1] - 2026-05-24

### Fixed
- **check_build_status recognizes `status: "completed"`** (`2988e6d`) — BKG v2 returns `status: "completed"` with graph data inline in `response.data`. The previous code only handled `status: "ready"` and the no-status fallback, falling through to `status: "unknown"` for completed-with-status responses. This left builds wrongly tracked as active until 10-min ghost-eviction, blocking new sequential builds.
- **Remove language_mismatch block** (`109a63e`) — The `language` parameter controls which corpus to search, not the language of search keywords. The old check falsely blocked legitimate cross-language searches (e.g., Finnish person names in English media). Entire `detectLanguageMismatch` function removed.

### Added
- **Sequential build enforcement** (`121f611`) — MCP server now blocks new BKG builds (v1 and v2) while one is already in progress. Returns `status: "blocked"` with the active build's status URL.
- **Ghost build detection** (`121f611`) — Any tracked build older than 10 minutes is automatically evicted as a "ghost." Prevents stale entries from permanently blocking new builds.
- **Poll round limiter** (`121f611`) — `headai_check_build_status` stops after 5 rounds (~4 min) and returns the visualizer bookmark URL instead of hanging indefinitely.

## [1.2.0] - 2026-05-22

### Added
- **BKG v2 tool** (`d37a88e`) — New `headai_build_knowledge_graph_v2` with auto-legend detection, improved parameter handling.
- **Dataset inventory** (`d2effbe`) — Added dataset inventory, ontology presets, and data volume thresholds to tool descriptions.
- **Comprehensive API docs** (`3675a76`) — Full parameter reference for all 24 tools.

### Changed
- **Default BKG size 100 -> 300** (`457aeb9`) — Larger default graph size for more comprehensive results.
- **Keyword quality guidance** (`5fc5a76`) — BKG tool descriptions now include guidance on writing effective search keywords.
- **v2 BKG quality** (`a5c62e0`) — Recommend `only_compounds` + `noise_list` for better graph quality.

### Removed
- **External-LLM tools** (`011c756`) — Removed `composer` and `describe_graph` tools. Blocked `USE_GPT` flag.

### Fixed
- **BKG gate guardrails** (`00fede1`) — Improved guardrails for BKG confirmation gates, Compass, and tool descriptions.

## [1.1.9] - 2026-05-21

### Fixed
- **Curriculum docs** (`d37ebb6`) — Added `author:` / `programme:` prefix documentation to BKG tool description.
- **News dataset guidance** (`1a1b7fa`, `811df5c`) — Rewrote news dataset description from warning to use cases with city/country guidance.
- **Product-grade presentation** (`927b802`, `661f17e`) — Hide technical internals from users. Purged report numbers and technical params from user-facing text.
- **Curriculum institutions** (`88fc650`) — Verified institution list, added hyphen warning and language tip.
- **BKG payload** (`2f66077`) — Added missing `type`, `update`, and empty-string params to BKG payload.

## [1.1.8] - 2026-05-14

### Fixed
- **Async BKG + Signals** (`58355f9`) — Fire-and-forget with polling tool for long-running builds.
- **OAuth DCR** (`1b8c77b`) — Returns `client_secret_post` for Perplexity compatibility.
- **Build status polling** (`4ad504f`) — `check_build_status` polls internally (45s) to avoid session timeouts.

### Added
- **MCP discovery** (`78b6fb5`) — `/.well-known/mcp.json` for Perplexity auto-discovery. Fixed tool count.

## [1.1.7] - 2026-05-08

### Added
- **Playbook tool** (`b60233d`) — `headai_get_playbook` provides single source of truth for orchestrator instructions.
- **Digital Twin improvements** (`3489fcf`) — Better description, correct annotations, playbook integration.

## [1.1.6] - 2026-05-07

### Fixed
- **Sequential build guardrails** (`066627f`) — Prevent parallel timeout cascades for BKG builds.
- **Identity hallucination** (`4b337ee`) — Prevent LLM from hallucinating tool identities. Clarify BuildSignals has no confirmation gate.

## [1.1.5] - 2026-05-05

### Fixed
- **Async polling** (`1efc1a4`) — Added async polling to TextToGraph and TextToKeywords.
- **BKG empty graph_url** (`e70035d`) — Handle case where BKG returns empty `graph_url`. Fix `list_token_data` 403 Forbidden.

## [1.1.4] - 2026-04-22 to 2026-04-24

### Added
- **Compass quality summary** (`b28bdc1`, `bfc2d3b`) — Analyst-style match quality summary in Compass results with crash protection.
- **Server resilience** (`6185c52`) — Health check endpoint, crash protection, startup self-test.
- **Progress heartbeats** (`1fe5218`, `6ce2828`) — Prevent `-32001` timeout errors on Compass, BKG, Scorecard, and BuildSignals.

### Reverted
- **Compass quality redesign** (`4965d60`) — Reverted emoji-based design in favor of analyst-style approach.

## [1.1.3] - 2026-04-20 to 2026-04-21

### Added
- **Concurrency guard** (`6356e6b`) — `MAX_CONCURRENT_HEAVY=1` prevents parallel heavy operations.
- **Internal name guardrail** (`b45922e`) — Never expose internal tool names or data pipeline details to users.

### Fixed
- **Size conflict** (`f2e0158`) — Confirmation gate now uses requested size instead of forcing 50.
- **Visualizer link** (`a3c4983`) — Match graph URL by `legend` / `search_text` instead of index.
- **Career Intelligence rename** (`d7c7166`) — Renamed all ENOT references throughout.
- **4 tool fixes** (`bd8ce04`) — Compass timeout 320s, Analyst async retry, jobs `country_limit` default, skill normalization for `linkedin_learning`.
- **QA schema alignment** (`4b3cb91`) — Compass jobs need `[mode, domain]`, Analyst params trimmed.

## [1.1.2] - 2026-04-14 to 2026-04-17

### Added
- **Career Intelligence suite** (`61889c5`) — Three-agent system (Skills Profiler, Career Navigator, Foresight Agent). Fix BKG/TTG async bugs.
- **tiedejatutkimus dataset** (`c7967ad`) — Added as standalone dataset in BKG and estimate_size tools.

### Fixed
- **BKG time-lock removed** (`518cac7`) — Prevent Claude.ai tool-use limit exhaustion.
- **BuildSignals polling** (`971627a`) — Handle endpoints returning data without status field.
- **Career Intelligence rename** (`1ee3a56`) — Renamed from ENOT to Headai Career Intelligence.
- **5 QA issues** (`9117271`) — Fixes from QA board.
- **Error handling guardrails** (`6413057`) — Prevent LLM hallucination spirals on errors.
- **Hash mismatch** (`abb7579`) — Fix confirmation gate hash mismatch when size > 50.

## [1.1.1] - 2026-04-06 to 2026-04-07

### Added
- **Confirmation gate** (`2620e2b` -> `a81c328`) — Hash-based enforcement replacing boolean gates. All parameters are mandatory blockers. Dataset-specific questions.
- **Visual report tool** (`4e617aa`, `7fbe858`, `1b30a32`) — Interactive visual reports from graph data. Returns structured data.
- **Language-keyword mismatch** (`11c2bd4`) — Detection for mismatched search language and keywords. *(Later removed in 1.2.1)*
- **Junior report catalog** (`bd0758a`) — Full report catalog in `run_analyst` with smart report selection.
- **Discovery bundles** (`205b1fe`) — Claude-as-interpreter pattern with translation guide.

### Changed
- **Tool list cleanup** (`6846920`) — Removed 4 UI-only tools, down to 19 tools.
- **MCP prompts** (`17287a7`) — Upgraded to full orchestration system (13 prompts).
- **Default size 50** (`8c80265`) — Quick first look, ask user before going bigger.
- **ChatGPT compatibility** (`205f14f`) — All tools marked `readOnlyHint:true`.

### Fixed
- **estimate_size guardrail** (`cf2b074`, `d0416cc`) — Only on user request, not auto-called.
- **Safety guardrails** (`aa6d0b9`, `0e6361b`, `91f312b`) — Default size=200, hard cap 1000, 2-core limit warning, no retries, no hallucinated names.
- **Copilot openAIndirectAttack** (`087a242`, `bb85ada`) — Strip directive language from tool responses. Pure JSON responses.
- **Async polling** (`c60ae01`) — Poll on all async statuses including 'in calculation' and 'ready'.

## [1.1.0] - 2026-04-03

### Added
- **OAuth branding** (`ffc49d4`, `8fbffbb`, `f06524d`, `f3439d8`, `846f00b`) — Branded OAuth authorize page with Headai logo, identity, EULA link, and landing page.
- **Enhanced tool descriptions** (`4b61747`) — Usage guidance for all AI platforms.
- **MCP prompts** (`2e61504`) — Built-in workflow skills served to all connected AI clients.
- **Legacy SSE transport** (`d90a0eb`) — Support for Perplexity and older MCP clients.

### Fixed
- **Visualizer URL rewrite** (`38be6f5`) — Rewrite old metatron visualizer URLs to cloud.headai.com.

## [1.0.0] - 2026-04-02

### Added
- **Initial release** (`479830c`) — Headai MCP Server with 23 tools, dual transport (Streamable HTTP + SSE), Bearer auth.
- **OAuth 2.0** (`f2113d0`, `9f2ab98`) — MCP-spec OAuth for Claude.ai, ChatGPT, and multi-client auth.
- **Railway deployment** (`932467a` -> `fd54136`) — Dockerfile builder, Alpine base, healthcheck configuration.

### Security
- **Remove authless fallback** (`2d4c7ed`) — Require OAuth or Bearer token for all requests.
