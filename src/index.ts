#!/usr/bin/env node
/**
 * Headai MCP Server
 *
 * Connects Claude (or any MCP client) to Headai's Core Engine APIs:
 * - TextToGraph: Convert text into semantic knowledge graphs
 * - TextToKeywords: Extract weighted keywords from text
 * - BuildKnowledgeGraph: Build graphs from datasets (async)
 * - Scorecard: Compare two knowledge graphs
 * - Compass: AI-powered recommendations
 * - JoinKnowledgeGraphs: Merge multiple graphs
 * - ModifyKnowledgeGraph: Filter/refine graphs
 * - TranslateKnowledgeGraph: Translate graphs between languages
 * - BuildSignals: Trend analysis (async)
 * - DigitalTwinStorage: Store/retrieve competency profiles
 *
 * Base URL: https://megatron.headai.com
 * Auth: API-key header
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import axios, { AxiosError } from "axios";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE_URL = process.env.HEADAI_API_URL || "https://megatron.headai.com";
const DEFAULT_API_KEY = process.env.HEADAI_API_KEY || "";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 120; // 6 minutes max
const CHARACTER_LIMIT = 25000;

// ── Shared utilities (API-key-aware) ──────────────────────────────────────

function getAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "Authorization": `API-key ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

async function headaiPost<T>(apiKey: string, endpoint: string, data: Record<string, unknown>): Promise<T> {
  const response = await axios.post(`${API_BASE_URL}/${endpoint}`, data, {
    headers: getAuthHeaders(apiKey),
    timeout: 60000,
  });
  return response.data as T;
}

async function headaiGet<T>(apiKey: string, endpoint: string, params: Record<string, unknown>): Promise<T> {
  const response = await axios.get(`${API_BASE_URL}/${endpoint}`, {
    params,
    headers: getAuthHeaders(apiKey),
    timeout: 60000,
  });
  return response.data as T;
}

interface AsyncJobResponse {
  status: string;
  location: string;
  [key: string]: unknown;
}

async function pollUntilReady(apiKey: string, initialResponse: AsyncJobResponse): Promise<unknown> {
  let { status, location } = initialResponse;
  let attempts = 0;

  // If already ready on first response, fetch the final result immediately
  if (typeof status === "string" && status === "ready" && location) {
    const result = await axios.get(location, { timeout: 60000 });
    return result.data;
  }

  while (
    typeof status === "string" &&
    (status.includes("work in progress") || status.includes("is in queue") || status.includes("in calculation")) &&
    attempts < MAX_POLL_ATTEMPTS
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollResponse = await axios.get(location, {
      headers: getAuthHeaders(apiKey),
      timeout: 30000,
    });
    status = pollResponse.data.status;
    location = pollResponse.data.location || location;
    attempts++;

    if (typeof status === "string" && status === "ready") {
      // Fetch the final result
      const result = await axios.get(location, { timeout: 60000 });
      return result.data;
    }
  }

  if (attempts >= MAX_POLL_ATTEMPTS) {
    throw new Error(`Job timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. Last status: ${status}. You can check the result later at: ${location}`);
  }

  return initialResponse;
}

function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axErr = error as AxiosError;
    if (axErr.response) {
      const status = axErr.response.status;
      const data = axErr.response.data;
      switch (status) {
        case 401:
          return "Error: Unauthorized. Check your HEADAI_API_KEY is correct and not expired.";
        case 403:
          return "Error: Forbidden. Your API key may not have access to this endpoint.";
        case 404:
          return "Error: Endpoint not found. The API URL may be incorrect.";
        case 429:
          return "Error: Rate limit exceeded. Wait a moment and try again.";
        default:
          return `Error: Headai API returned ${status}. ${typeof data === "string" ? data : JSON.stringify(data)}`;
      }
    } else if (axErr.code === "ECONNABORTED") {
      return "Error: Request timed out. The operation may take longer — try with simpler parameters or smaller data.";
    }
    return `Error: Network issue — ${axErr.message}`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function truncateIfNeeded(text: string): string {
  if (text.length > CHARACTER_LIMIT) {
    return text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use filters or smaller inputs to reduce output size]";
  }
  return text;
}

/**
 * Generate a compact summary of a Headai JSON result.
 * Works for knowledge graphs, scorecards, signals, etc.
 */
function summarizeGraphData(data: unknown): string {
  if (!data || typeof data !== "object") return "Empty or non-object response.";
  const obj = data as Record<string, unknown>;

  // Handle wrapper: { data: { nodes: [...], legends: {...} } }
  const inner = (obj.data && typeof obj.data === "object") ? obj.data as Record<string, unknown> : obj;

  const lines: string[] = [];

  // Legends
  if (inner.legends && typeof inner.legends === "object") {
    lines.push(`Legends: ${JSON.stringify(inner.legends)}`);
  }

  // Title
  if (inner.title) lines.push(`Title: ${inner.title}`);

  // Nodes
  if (Array.isArray(inner.nodes)) {
    const nodes = inner.nodes as Array<Record<string, unknown>>;
    lines.push(`Nodes: ${nodes.length}`);

    // Count per group
    const groupCounts: Record<string, number> = {};
    for (const n of nodes) {
      const g = String(n.group ?? "?");
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    }
    if (Object.keys(groupCounts).length > 1) {
      lines.push(`Groups: ${JSON.stringify(groupCounts)}`);
    }

    // Top 10 by weight then value
    const sorted = [...nodes].sort((a, b) => {
      const wDiff = Number(b.weight ?? 0) - Number(a.weight ?? 0);
      if (wDiff !== 0) return wDiff;
      return Number(b.value ?? 0) - Number(a.value ?? 0);
    });
    lines.push("Top 10 nodes (by weight):");
    for (const n of sorted.slice(0, 10)) {
      lines.push(`  - ${n.label} (w=${n.weight}, v=${n.value}, g=${n.group})`);
    }
  }

  // Edges (canonical location: data.edges[])
  if (Array.isArray(inner.edges)) {
    const edges = inner.edges as Array<Record<string, unknown>>;
    lines.push(`Edges: ${edges.length}`);
    if (edges.length > 0) {
      const values = edges.map(e => Number(e.value ?? 0)).filter(v => !isNaN(v));
      if (values.length > 0) {
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const avgVal = values.reduce((a, b) => a + b, 0) / values.length;
        lines.push(`Edge value range: ${minVal}-${maxVal} (avg ${avgVal.toFixed(1)})`);
      }
      // Top 5 strongest edges
      const sortedEdges = [...edges].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
      lines.push("Top 5 strongest connections:");
      for (const e of sortedEdges.slice(0, 5)) {
        lines.push(`  - ${e.title || `node ${e.from} ↔ node ${e.to}`} (value=${e.value})`);
      }
    }
  }

  // Legacy links field (fallback)
  if (Array.isArray(inner.links) && !Array.isArray(inner.edges)) {
    lines.push(`Links: ${(inner.links as unknown[]).length}`);
  }

  // Scores (scorecard-specific)
  if (inner.scores && typeof inner.scores === "object") {
    const scores = inner.scores as Record<string, unknown>;
    lines.push(`Scores: full_score=${scores.full_score}, full_score_normalized=${scores.full_score_normalized}, important_topics_score=${scores.important_topics_score}`);
    if (Array.isArray(scores.important_topics_found)) {
      lines.push(`Important topics found: ${(scores.important_topics_found as string[]).length}`);
    }
    if (Array.isArray(scores.important_topics_missing)) {
      lines.push(`Important topics missing: ${(scores.important_topics_missing as string[]).length}`);
    }
  }

  // Indicators
  if (inner.indicators && typeof inner.indicators === "object") {
    const ind = inner.indicators as Record<string, unknown>;
    const parts: string[] = [];
    if (ind.meaningful_words_count !== undefined) parts.push(`words=${ind.meaningful_words_count}`);
    if (ind.data_quality_factor !== undefined) parts.push(`quality=${ind.data_quality_factor}`);
    if (ind.data_size_balance !== undefined) parts.push(`balance=${Number(ind.data_size_balance).toFixed(3)}`);
    if (parts.length > 0) lines.push(`Indicators: ${parts.join(", ")}`);
  }

  // Signals-specific
  if (inner.signals && Array.isArray(inner.signals)) {
    lines.push(`Signals: ${(inner.signals as unknown[]).length}`);
  }

  return lines.join("\n");
}

// ── Server Factory ─────────────────────────────────────────────────────────
// Creates a fresh McpServer instance with all 23 tools registered.
// Called once for stdio mode, once per session for HTTP mode.

function createServer(apiKey: string = DEFAULT_API_KEY): McpServer {
if (!apiKey) {
  console.error("WARNING: No API key provided. All Headai API calls will fail with 401.");
}
const server = new McpServer({
  name: "headai-mcp-server",
  version: "1.0.0",
});

// ── Tool: TextToGraph ──────────────────────────────────────────────────────

server.registerTool(
  "headai_text_to_graph",
  {
    title: "Text to Knowledge Graph",
    description: `Convert free-form text into a structured semantic knowledge graph using Headai's Graphmind AI.

Paste any text (job description, article, strategy doc, curriculum, etc.) and get back a knowledge graph with weighted concepts, clusters, and relationships.

Args:
  - text (string, required): The text to analyze (any length)
  - language (string): ISO language code — "en", "fi", "sv", "de", etc. (default: "en")
  - ontology (string): Ontology to use (default: "headai")
  - legend (string): Optional label for the graph
  - word_type (string, optional): Set to "only_compounds" to return only compound/multi-word concepts, or leave empty for all
  - translate_to (string, optional): Translate output to another language (e.g. "fi", "sv", "de", "fr", "es", etc.)
  - noise_list (string, optional): Comma-separated keywords to exclude from results
  - use_stored_noise (boolean, optional): Use noise list stored for API key (default: false)
  - high_privacy_mode (boolean): If true, no text/output stored on server (default: false)

Returns: Knowledge graph JSON with nodes (concepts), edges (relationships), and groups (clusters).`,
    inputSchema: {
      text: z.string().min(10, "Text must be at least 10 characters").describe("The text to convert into a knowledge graph"),
      language: z.string().default("en").describe("ISO language code (en, fi, sv, de, etc.)"),
      ontology: z.string().default("headai").describe("Ontology to use for semantic analysis"),
      legend: z.string().optional().describe("Label for the resulting graph"),
      word_type: z.string().optional().describe("'only_compounds' for compound words only, 'none' for all words"),
      translate_to: z.string().optional().describe("Translate output to language code (fi, sv, de, fr, es, etc.)"),
      noise_list: z.string().optional().describe("Comma-separated keywords to exclude from results"),
      use_stored_noise: z.boolean().optional().describe("Use noise list stored for API key"),
      high_privacy_mode: z.boolean().default(false).describe("If true, nothing stored server-side"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        text: params.text,
        language: params.language,
        ontology: params.ontology,
        legend: params.legend || "",
        output: "json",
        high_privacy_mode: params.high_privacy_mode,
        update: "false",
      };
      if (params.word_type) payload.word_type = params.word_type;
      if (params.translate_to) payload.translate_to = params.translate_to;
      if (params.noise_list) payload.noise_list = params.noise_list;
      if (params.use_stored_noise !== undefined) payload.use_stored_noise = params.use_stored_noise;

      const result = await headaiPost(apiKey,"TextToGraph", payload);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: TextToKeywords ───────────────────────────────────────────────────

server.registerTool(
  "headai_text_to_keywords",
  {
    title: "Text to Keywords",
    description: `Extract weighted keywords and key concepts from text using Headai's NLP engine.

Returns a list of keywords with weights indicating their importance/specificity in the text.
Also returns quality indicators (information_quality, information_density, knowledge_gravity).

Args:
  - text (string, required): Text to extract keywords from
  - language (string): ISO language code (default: "en")
  - ontology (string): Ontology to use — "headai" (168K en), "esco" (136K en), "headai_optimized" (54K en), "lightcast", "yso", "fibo" (default: "headai")
  - keyword_type (string, optional): Set to "only_compounds" to return only precise compound words, or leave empty for all
  - noise_list (string, optional): Comma-separated list of keywords to exclude from results (e.g. "integrointi,laitteistot")
  - use_stored_noise (boolean, optional): If a noise list is stored for the API key, enable it (default: false)
  - high_privacy_mode (boolean, optional): Process immediately without storing user data (default: false)

Returns: JSON with extracted keywords (concept, displayname, weight, relevancy), quality indicators.`,
    inputSchema: {
      text: z.string().min(10).describe("Text to extract keywords from"),
      language: z.string().default("en").describe("ISO language code"),
      ontology: z.string().default("headai").describe("Ontology: headai, esco, headai_optimized, lightcast, yso, fibo"),
      keyword_type: z.string().optional().describe("'only_compounds' for precise compound words only, or empty for all"),
      noise_list: z.string().optional().describe("Comma-separated keywords to exclude from results"),
      use_stored_noise: z.boolean().optional().describe("Use noise list stored for API key"),
      high_privacy_mode: z.boolean().optional().describe("Process immediately, don't store user data"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        text: params.text,
        language: params.language,
        ontology: params.ontology,
        output: "json",
      };
      if (params.keyword_type) payload.keyword_type = params.keyword_type;
      if (params.noise_list) payload.noise_list = params.noise_list;
      if (params.use_stored_noise !== undefined) payload.use_stored_noise = params.use_stored_noise;
      if (params.high_privacy_mode !== undefined) payload.high_privacy_mode = params.high_privacy_mode;

      const result = await headaiPost(apiKey,"TextToKeywords", payload);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: BuildKnowledgeGraph (async) ──────────────────────────────────────

server.registerTool(
  "headai_build_knowledge_graph",
  {
    title: "Build Knowledge Graph from Dataset",
    description: `Build a semantic knowledge graph from a Headai dataset (job ads, articles, curricula, etc.).

This is an ASYNC operation — may take 5 seconds to 15 minutes depending on dataset size. The tool polls automatically until the graph is ready.

Datasets: job_ads, doaj_articles, curriculum, theseus, investment_data, news, imported, jobs_by_company_name

⚠️ CRITICAL — Dataset-specific REQUIRED parameters:
  • doaj_articles: MUST provide search_year (e.g., 2024) and language. Without search_year, returns EMPTY graph.
  • investment_data: MUST provide search_year and language. May have limited data availability.
  • news: MUST provide search_year and language.
  • job_ads: search_year optional (works without it). Supports weighted_search_output.
  • curriculum: search_year optional. Supports "author:" and "programme:" prefixes in search_text.
  • theseus: search_year optional. Supports affiliation filter.

Note: country and city are mutually exclusive. affiliation is only for doaj_articles/theseus.
Tip: Large graphs produce _s (500), _m (2000), _l (4000 nodes) variants — add before .json in the URL.

Args:
  - dataset (string, required): Dataset name — "job_ads", "doaj_articles", "curriculum", "theseus", "investment_data", "news", "imported"
  - language (string): Language code (default: "en"). REQUIRED for doaj_articles, investment_data, news.
  - ontology (string): Ontology — "headai", "esco", "lightcast", "yso", "fibo" (default: "headai")
  - search_text (string): Comma-separated keywords to filter. Hyphens=AND, commas=OR (e.g. "environment-and-energy,digital-and-energy")
  - legend (string): Label/description for the graph
  - search_year (number): Year filter (e.g., 2024). ⚠️ REQUIRED for doaj_articles, investment_data, news datasets!
  - search_month (string): Month filter (e.g., "03")
  - search_day (string): Day filter (e.g., "15")
  - startDate (string): Start date for date range (YYYY-MM-DD format)
  - endDate (string): End date for date range (YYYY-MM-DD format)
  - country (string): Country code filter (e.g., "fi", "de"). Mutually exclusive with city.
  - city (string): City name filter (e.g., "Helsinki", "Tampere"). Mutually exclusive with country.
  - affiliation (string): Filter by affiliation — ONLY for doaj_articles and theseus datasets (e.g., "Tampere University")
  - size (number): Sample size 1-5000 (default: 50 for testing, use 200+ for production, 500-1000 for city-level, ~1000 for Scorecard/Signals input)
  - word_type (string): Set to "only_compounds" for compound words only, or leave empty for all
  - weighted_search_output (boolean): Match search_text as a cluster. Only for job_ads dataset.
  - additional_data (boolean): Add extra info like relations. Only supported with Lightcast ontology.
  - noise_list (string): Comma-separated keywords to exclude from results
  - use_stored_noise (boolean): Use noise list stored for API key

Returns: Full knowledge graph JSON with nodes, edges, indicators, sources, and tags.`,
    inputSchema: {
      dataset: z.string().describe("Dataset: job_ads, doaj_articles, curriculum, theseus, investment_data, news, imported"),
      language: z.string().default("en").describe("Language code"),
      ontology: z.string().default("headai").describe("Ontology: headai, esco, lightcast, yso, fibo"),
      search_text: z.string().optional().describe("Comma-separated keywords. Hyphens=AND, commas=OR"),
      legend: z.string().optional().describe("Label/description for the graph"),
      search_year: z.union([z.string(), z.number()]).optional().describe("Year filter (e.g., 2024). REQUIRED for doaj_articles, investment_data, news — empty returns 0 results!"),
      search_month: z.union([z.string(), z.number()]).optional().describe("Month filter (e.g., 3 or '03'). Use 0 for all months."),
      search_day: z.union([z.string(), z.number()]).optional().describe("Day filter (e.g., 15 or '15'). Use 0 for all days."),
      startDate: z.string().optional().describe("Start date YYYY-MM-DD for date range queries"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD for date range queries"),
      country: z.string().optional().describe("Country code (e.g., 'fi'). Mutually exclusive with city"),
      city: z.string().optional().describe("City name (e.g., 'Helsinki'). Mutually exclusive with country"),
      affiliation: z.string().optional().describe("Affiliation filter — ONLY for doaj_articles/theseus"),
      size: z.union([z.string(), z.number()]).default(50).describe("Sample size 1-5000 (default 50 for testing, 200+ production, ~1000 for Scorecard/Signals)"),
      word_type: z.string().optional().describe("'only_compounds' for compound words only, 'none' for all words"),
      weighted_search_output: z.boolean().optional().describe("Match search_text as cluster (job_ads only)"),
      additional_data: z.boolean().optional().describe("Add extra info like relations (Lightcast only)"),
      noise_list: z.string().optional().describe("Comma-separated keywords to exclude"),
      use_stored_noise: z.boolean().optional().describe("Use noise list stored for API key"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const bkgPayload: Record<string, unknown> = {
        dataset: params.dataset,
        language: params.language,
        ontology: params.ontology,
        search_text: params.search_text || "",
        search_year: params.search_year !== undefined ? Number(params.search_year) : 0,
        search_month: params.search_month !== undefined ? Number(params.search_month) : 0,
        search_day: params.search_day !== undefined ? Number(params.search_day) : 0,
        size: Number(params.size),
        output: "json",
      };
      if (params.legend) bkgPayload.legend = params.legend;
      if (params.startDate) bkgPayload.startDate = params.startDate;
      if (params.endDate) bkgPayload.endDate = params.endDate;
      if (params.country) bkgPayload.country = params.country;
      if (params.city) bkgPayload.city = params.city;
      if (params.affiliation) bkgPayload.affiliation = params.affiliation;
      if (params.word_type) bkgPayload.word_type = params.word_type;
      if (params.weighted_search_output !== undefined) bkgPayload.weighted_search_output = params.weighted_search_output;
      if (params.additional_data !== undefined) bkgPayload.additional_data = params.additional_data;
      if (params.noise_list) bkgPayload.noise_list = params.noise_list;
      if (params.use_stored_noise !== undefined) bkgPayload.use_stored_noise = params.use_stored_noise;

      const response = await headaiPost<AsyncJobResponse>(apiKey,"BuildKnowledgeGraph", bkgPayload);

      // If async, poll until ready
      if (response.status && (response.status.includes("work in progress") || response.status.includes("is in queue"))) {
        const result = await pollUntilReady(apiKey, response);
        const text = truncateIfNeeded(JSON.stringify(result, null, 2));
        return { content: [{ type: "text", text }] };
      }

      const text = truncateIfNeeded(JSON.stringify(response, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Scorecard ────────────────────────────────────────────────────────

server.registerTool(
  "headai_scorecard",
  {
    title: "Compare Two Knowledge Graphs (Scorecard)",
    description: `Compare two knowledge graphs and produce a gap analysis scorecard.

The scorecard identifies: (1) Common concepts shared by both, (2) Concepts unique to graph 1, (3) Concepts unique to graph 2. Great for curriculum-vs-job-market, before-vs-after, or benchmark comparisons.

Supports three input modes (+ mixed):
  - Graph vs Graph: provide map_url_1 and map_url_2
  - Text vs Text: provide text_1 and text_2 (slow — internally runs TextToGraph on both)
  - Graph vs Precalculated SDG: provide item and scorecard
  - Mixed: one graph URL + one text (e.g. map_url_1 + text_2)

SDG scorecard presets: un_sdg_goal1_en through un_sdg_goal17_en, community_sdg2022_goal1_en through community_sdg2022_goal17_en, un_sdg_goal1_fi through un_sdg_goal17_fi, un_sdg_goal1_sv through un_sdg_goal17_sv.

Returns: Combined scorecard graph with three groups (1=common, 2=unique-left, 3=unique-right), plus scores and subclusters.`,
    inputSchema: {
      map_url_1: z.string().optional().describe("URL to first knowledge graph JSON"),
      map_url_2: z.string().optional().describe("URL to second knowledge graph JSON"),
      text_1: z.string().optional().describe("Raw text for first comparison (alternative to map_url_1)"),
      text_2: z.string().optional().describe("Raw text for second comparison (alternative to map_url_2)"),
      item: z.string().optional().describe("URL/ID of graph for Mode 3 (graph vs precalculated scorecard)"),
      scorecard: z.string().optional().describe("Precalculated scorecard name (e.g. 'un_sdg_goal1_en' through 'un_sdg_goal17_en')"),
      legend_1: z.string().optional().describe("Label for first graph/text"),
      legend_2: z.string().optional().describe("Label for second graph/text"),
      language: z.string().default("en").describe("Language code"),
      ontology: z.string().optional().describe("Ontology: headai (default), esco, lightcast, yso, fibo"),
      limit: z.number().optional().describe("Exclude weights lower than value (0-5). 0=all, 5=only most important"),
      noise_list: z.string().optional().describe("Comma-separated keywords to exclude from results"),
      use_stored_noise: z.boolean().optional().describe("Use noise list stored for API key"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        language: params.language,
        output: "json",
      };
      if (params.map_url_1) payload.map_url_1 = params.map_url_1;
      if (params.map_url_2) payload.map_url_2 = params.map_url_2;
      if (params.text_1) payload.text_1 = params.text_1;
      if (params.text_2) payload.text_2 = params.text_2;
      if (params.item) payload.item = params.item;
      if (params.scorecard) payload.scorecard = params.scorecard;
      if (params.legend_1) payload.legend_1 = params.legend_1;
      if (params.legend_2) payload.legend_2 = params.legend_2;
      if (params.ontology) payload.ontology = params.ontology;
      if (params.limit !== undefined) payload.limit = params.limit;
      if (params.noise_list) payload.noise_list = params.noise_list;
      if (params.use_stored_noise !== undefined) payload.use_stored_noise = params.use_stored_noise;

      const response = await headaiPost<AsyncJobResponse>(apiKey,"Scorecard", payload);

      if (response.status && (response.status.includes("work in progress") || response.status.includes("is in queue"))) {
        const result = await pollUntilReady(apiKey, response);
        const text = truncateIfNeeded(JSON.stringify(result, null, 2));
        return { content: [{ type: "text", text }] };
      }

      const text = truncateIfNeeded(JSON.stringify(response, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Compass ──────────────────────────────────────────────────────────

server.registerTool(
  "headai_compass",
  {
    title: "Compass Recommendations",
    description: `Get AI-powered recommendations using Headai's Compass engine.

Compass matches a skill profile against a namespace (jobs, courses, etc.) and returns ranked recommendations.

Request modes: "match" (best overlap), "zpd" (zone of proximal development), "demand" (market demand), "jobs" (job recommendations — MUST be included for job namespaces).

Namespaces — Education: "metropolia", "Tuni", "Aalto University", "University of Helsinki", "koulutusfi", "linkedin_learning", "moncompteformation", "inokufu udemy", "classcentral", "any".
Namespaces — Jobs: "TMT", "Duunitori", "MOL", "Eures", "any".

Args:
  - skills (string[], required): User's current skills as concept strings (e.g. ["python", "machine_learning"])
  - namespace (string, required): Target namespace to search
  - request (string[], optional): Modes array (default: ["match"]). For jobs use ["jobs", "match"]
  - interests (string[], optional): User's interest/goal skills
  - language (string): Language code (default: "en")
  - country_limit (string[], optional): ISO country codes for job search (e.g. ["fi"])
  - city_limit (string[], optional): City names for job search (e.g. ["helsinki"])

Returns: Ranked recommendations with scores, matching skills, new skills to gain.`,
    inputSchema: {
      skills: z.array(z.string()).min(1).describe("User's current skills as concept strings"),
      namespace: z.string().describe("Target namespace (e.g., 'metropolia', 'TMT', 'any')"),
      request: z.array(z.string()).default(["match"]).describe("Modes: 'match', 'zpd', 'demand', 'jobs', 'companies', 'curriculum', 'researcher'"),
      interests: z.array(z.string()).optional().describe("User's interest/goal skills"),
      language: z.string().default("en").describe("Language code"),
      completed: z.array(z.string()).optional().describe("Completed courses (course recs only)"),
      mandatory: z.array(z.string()).optional().describe("Mandatory courses (course recs only)"),
      suggest_from_set: z.array(z.string()).optional().describe("Constrain results to these course IDs"),
      country_limit: z.array(z.string()).optional().describe("ISO country codes for job search"),
      city_limit: z.array(z.string()).optional().describe("City names for job search"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const data: Record<string, unknown> = {
        namespace: params.namespace,
        request: params.request,
        skills: params.skills,
        language: params.language,
      };
      if (params.interests) data.interests = params.interests;
      if (params.completed) data.completed = params.completed;
      if (params.mandatory) data.mandatory = params.mandatory;
      if (params.suggest_from_set) data.suggest_from_set = params.suggest_from_set;
      if (params.country_limit) data.country_limit = params.country_limit;
      if (params.city_limit) data.city_limit = params.city_limit;

      const payload: Record<string, unknown> = {
        output: "json",
        data,
      };

      const result = await headaiPost(apiKey,"Compass", payload);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: JoinKnowledgeGraphs ──────────────────────────────────────────────

server.registerTool(
  "headai_join_graphs",
  {
    title: "Join Knowledge Graphs",
    description: `Merge two or more knowledge graphs into a single combined graph.

Useful for combining graphs from different sources, time periods, or analyses into one unified view.

Args:
  - urls (string, required): Comma-separated URLs to graphs to join (2 or more)
  - title (string): Title for the merged result

Returns: Merged knowledge graph JSON (async — polls until ready).`,
    inputSchema: {
      urls: z.string().optional().describe("Comma-separated URLs to knowledge graph JSONs (e.g. 'url1,url2')"),
      graph_1: z.any().optional().describe("First graph as JSON object (alternative to urls)"),
      graph_2: z.any().optional().describe("Second graph as JSON object (alternative to urls)"),
      title: z.string().optional().describe("Title for the merged graph"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        title: params.title || "",
        output: "json",
      };
      if (params.urls) payload.urls = params.urls;
      if (params.graph_1) payload.graph_1 = params.graph_1;
      if (params.graph_2) payload.graph_2 = params.graph_2;
      const response = await headaiPost<AsyncJobResponse>(apiKey,"JoinKnowledgeGraphs", payload);

      // JoinKnowledgeGraphs is async — poll until ready
      const result = await pollUntilReady(apiKey, response);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: ModifyKnowledgeGraph ─────────────────────────────────────────────

server.registerTool(
  "headai_modify_graph",
  {
    title: "Modify Knowledge Graph",
    description: `Filter and refine a knowledge graph by removing nodes, adjusting weights, or filtering by keywords.

Use this after building a graph to clean it up before comparison, visualization, or export.

Args:
  - url (string, required): URL to the graph to modify
  - keywords (string): Comma-separated keywords to keep (filter)
  - weight (number): Minimum weight threshold (1-5)
  - value (number): Minimum value threshold
  - max_nodes (number): Maximum number of nodes to keep
  - remove (string): Comma-separated keywords to remove from graph
  - word_type (string): "only_compounds" for precise multi-word terms only
  - title (string): New title for the graph

Returns: Modified knowledge graph JSON (async — polls until ready).`,
    inputSchema: {
      url: z.string().describe("URL to the knowledge graph to modify"),
      keywords: z.string().optional().describe("Comma-separated keywords to filter/keep"),
      weight: z.union([z.string(), z.number()]).optional().describe("Minimum weight threshold (1-5)"),
      value: z.union([z.string(), z.number()]).optional().describe("Minimum value threshold"),
      max_nodes: z.union([z.string(), z.number()]).optional().describe("Maximum nodes to keep"),
      remove: z.string().optional().describe("Comma-separated keywords to remove"),
      word_type: z.string().optional().describe("'only_compounds' for multi-word terms only"),
      title: z.string().optional().describe("New title for the graph"),
      legend: z.string().optional().describe("Comma-separated legend labels for the graph"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        url: params.url,
        output: "json",
      };
      if (params.keywords) payload.keywords = params.keywords;
      if (params.weight) payload.weight = Number(params.weight);
      if (params.value) payload.value = Number(params.value);
      if (params.max_nodes) payload.max_nodes = Number(params.max_nodes);
      if (params.remove) payload.remove = params.remove;
      if (params.word_type) payload.word_type = params.word_type;
      if (params.title) payload.title = params.title;
      if (params.legend) payload.legend = params.legend;

      const response = await headaiPost<AsyncJobResponse>(apiKey,"ModifyKnowledgeGraph", payload);
      const result = await pollUntilReady(apiKey, response);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: TranslateKnowledgeGraph ──────────────────────────────────────────

server.registerTool(
  "headai_translate_graph",
  {
    title: "Translate Knowledge Graph",
    description: `Translate a knowledge graph from one language to another while preserving structure and relationships.

Args:
  - url (string, required): URL to the graph to translate
  - language (string, required): Source language of the graph (ISO 639-1)
  - translate_to (string, required): Target language code (e.g., "fi", "en", "de", "sv", "fr", "es")

Returns: Translated knowledge graph JSON (async — polls until ready).`,
    inputSchema: {
      url: z.string().optional().describe("URL to the knowledge graph to translate"),
      data: z.any().optional().describe("Graph JSON object (alternative to url). Do not use both url and data."),
      language: z.string().describe("Source language code (ISO 639-1)"),
      translate_to: z.string().describe("Target language code (BG, CS, DA, DE, EL, EN, ES, ET, FI, FR, HU, ID, IT, JA, LT, LV, NL, PL, PT, RO, RU, SK, SL, SV, TR, UK, ZH)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        language: params.language,
        translate_to: params.translate_to,
        output: "json",
      };
      if (params.url) payload.url = params.url;
      if (params.data) payload.data = params.data;
      const response = await headaiPost<AsyncJobResponse>(apiKey,"TranslateKnowledgeGraph", payload);
      const result = await pollUntilReady(apiKey, response);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: BuildSignals (async) ─────────────────────────────────────────────

server.registerTool(
  "headai_build_signals",
  {
    title: "Build Trend Signals",
    description: `Analyze trends across an ascending time series of knowledge graph snapshots.

This is an ASYNC operation. BuildSignals takes 2 or more graph snapshots ordered chronologically
and produces a signals analysis showing which concepts are emerging, increasing, stable,
declining, or disappearing over time. The output contains alternating snapshot and change maps.

⚠️ WHEN TO USE Signals vs Scorecard:
  - 2 snapshots: Works for Signals, but prefer Scorecard unless user explicitly asks for trends/change
  - 3+ snapshots: Recommended for robust Signals (enables groups 2 "constantly increasing" and 6 "constantly decreasing")
  - Time-based snapshots (years): Use Signals — e.g. "2020,2022,2024" shows evolution
  - Cross-source comparison: Use Signals with free-text legends — e.g. "Job Market,Investment,Research"
  - CRITICAL: A year in the query does NOT mean Signals! "osaamistarve 2025" → Snapshot. Only explicit change language ("trends", "muutos", "how has it changed") → Signals

Signal groups in output (up to 8):
  1=Emerging, 2=Constantly Increasing, 3=Increasing in last Map,
  4=Constant value, 5=Constant in last Map, 6=Constantly Decreasing,
  7=Decreasing in last Map, 8=Disappearing

IMPORTANT prediction rules:
  - predict=false (default): map_legends can be ANY free text labels
    (e.g. "Labor Market,Investments,Research" or "2022,2023,2024")
  - predict=true: map_legends MUST be year numbers in ascending order
    (e.g. "2020,2022,2024") — the system extrapolates a prediction for the next period

Args:
  - urls (string, required): Comma-separated graph URLs in ascending time series order (minimum 2)
  - map_legends (string, required): Comma-separated labels — one per URL. Years required if predict=true
  - predict (boolean): Generate a prediction map for the next period (default: false)
  - dataset (string): "doaj", "job_ads", or "custom". Controls auto-title generation. Use "custom" with your own graphs
  - title (string): Base title for the series — combined with dataset to auto-generate per-map titles

Returns: Time series JSON with data[] array of snapshot + change maps, plus info.timeLabels.
Visualization: https://megatron.headai.com/mapSeries.html?json_url=<result_url>
Analyst reports 400-408 can be run on signal output for deeper analysis.`,
    inputSchema: {
      urls: z.string().describe("Comma-separated graph URLs in ascending time series order (minimum 2)"),
      map_legends: z.string().describe("Comma-separated labels, one per URL. If predict=true, MUST be years (e.g. '2020,2022,2024'). If predict=false, can be free text (e.g. 'Labor Market,Research')"),
      predict: z.boolean().optional().default(false).describe("Generate prediction for next period. Requires year labels in map_legends"),
      dataset: z.string().optional().default("custom").describe("'doaj', 'job_ads', or 'custom' — controls auto-title generation"),
      title: z.string().optional().describe("Base title for the signal series (e.g. 'Skills demand prediction')"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        urls: params.urls,
        map_legends: params.map_legends,
        predict: params.predict ?? false,
        dataset: params.dataset ?? "custom",
        title: params.title ?? "Signal Analysis",
        output: "json",
      };

      const response = await headaiPost<AsyncJobResponse>(apiKey,"BuildSignals", payload);
      const result = await pollUntilReady(apiKey, response);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: DigitalTwinStorage ───────────────────────────────────────────────

server.registerTool(
  "headai_digital_twin",
  {
    title: "Digital Twin Storage",
    description: `Store or retrieve a competency/skill profile (digital twin) in Headai's storage.

Operations:
  - "add": Store a graph as a digital twin profile (creates new or updates existing)
  - "get": Retrieve a stored digital twin by key
  - "share": Generate a secure shareable link for a twin

Args:
  - operation (string, required): "add", "get", or "share"
  - twin_key (string, required): Unique identifier for the digital twin
  - graph_url (string): For "add" — URL to a graph to fetch and store as twin_graph

Returns: For "add": secure share link. For "get": the stored graph. For "share": a shareable URL.`,
    inputSchema: {
      operation: z.enum(["add", "get", "share"]).describe("Operation: add, get, or share"),
      twin_key: z.string().describe("Unique twin identifier (e.g. 'user_123')"),
      graph_url: z.string().optional().describe("Graph URL to store as twin (required for add)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      switch (params.operation) {
        case "add": {
          if (!params.graph_url) {
            return { content: [{ type: "text", text: "Error: graph_url is required for 'add' operation" }], isError: true };
          }
          // Fetch the graph data first, then send as twin_graph
          const graphResponse = await axios.get(params.graph_url, { timeout: 30000 });
          const result = await headaiPost(apiKey,"DigitalTwinStorage/AddToTwin", {
            twin_key: params.twin_key,
            twin_graph: graphResponse.data,
          });
          const text = truncateIfNeeded(JSON.stringify(result, null, 2));
          return { content: [{ type: "text", text }] };
        }
        case "get": {
          const result = await headaiGet(apiKey,"DigitalTwinStorage/GetTwin", {
            twin_key: params.twin_key,
          });
          const text = truncateIfNeeded(JSON.stringify(result, null, 2));
          return { content: [{ type: "text", text }] };
        }
        case "share": {
          const result = await headaiGet(apiKey,"DigitalTwinStorage/GetSecureShareLink", {
            twin_key: params.twin_key,
          });
          const text = truncateIfNeeded(JSON.stringify(result, null, 2));
          return { content: [{ type: "text", text }] };
        }
      }
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Fetch Graph by URL ───────────────────────────────────────────────

server.registerTool(
  "headai_fetch_graph",
  {
    title: "Fetch Knowledge Graph by URL",
    description: `Fetch and display a knowledge graph from its Headai storage URL.

Use this to retrieve the contents of a previously built graph, or to inspect any graph URL returned by other tools.

Args:
  - url (string, required): Full URL to the graph JSON (typically on megatron.headai.com/analysis/...)

Returns: The full knowledge graph JSON.`,
    inputSchema: {
      url: z.string().url().describe("Full URL to the knowledge graph JSON"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const response = await axios.get(params.url, { timeout: 30000 });
      const text = truncateIfNeeded(JSON.stringify(response.data, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Fetch Graph and Save to File ────────────────────────────────────────

server.registerTool(
  "headai_fetch_and_save",
  {
    title: "Fetch Graph and Save to File",
    description: `Fetch a knowledge graph or scorecard JSON from its URL and save it to a local file.

Use this instead of headai_fetch_graph when the result is large (scorecards, big knowledge graphs).
The full JSON is saved to disk; only a compact summary is returned in the response.
The AI can then read the saved file with the Read tool to process the data.

Args:
  - url (string, required): Full URL to the graph JSON (typically on megatron.headai.com/analysis/...)
  - save_path (string, required): Local file path to save the JSON (e.g. '/tmp/scorecard.json' or a workspace path)

Returns: A compact summary (node count, groups, top concepts) + the saved file path.`,
    inputSchema: {
      url: z.string().url().describe("Full URL to the knowledge graph JSON"),
      save_path: z.string().describe("Local file path to save the full JSON to"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const response = await axios.get(params.url, { timeout: 60000 });
      const data = response.data;

      // Ensure directory exists
      const dir = path.dirname(params.save_path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Save full JSON to file
      fs.writeFileSync(params.save_path, JSON.stringify(data, null, 2), "utf-8");
      const fileSize = fs.statSync(params.save_path).size;

      // Return summary only
      const summary = summarizeGraphData(data);
      const result = `File saved: ${params.save_path} (${(fileSize / 1024).toFixed(1)} KB)\n\n${summary}`;
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Get Jobs by Text ───────────────────────────────────────────────────

server.registerTool(
  "headai_get_jobs_by_text",
  {
    title: "Get Jobs by Text",
    description: `Search for real job listings matching skills, text, or keywords.

Posts to /Utils with action "get_jobs_by_text". Returns ranked job ads with match scores,
matching skills (reasoning), and missing skills (skill gaps).

Args:
  - search (string): Free text to search for jobs (e.g. "software developer")
  - keywords (string): Comma-separated skill keywords (e.g. "java, python, mysql"). Can come from TextToKeywords output.
  - area (string, required): City or region (e.g. "Helsinki")
  - country (string, required): ISO 2-letter country code (e.g. "fi")
  - language (string, required): ISO 2-letter language code (e.g. "fi", "en")
  - author (string, optional): Filter by job source — "mol" or "tmt" (Työmarkkinatori)
  - limit (number, optional): Max results 10-50, default 20
  - remove (string, optional): Comma-separated keywords to exclude from results (e.g. "intern, junior")

Returns: Job listings with url, title, description, city, score, reasoning (matched skills), missing_skills.`,
    inputSchema: {
      search: z.string().default("").describe("Free text search query"),
      keywords: z.string().default("").describe("Comma-separated skill keywords"),
      area: z.string().describe("City or region to search in"),
      country: z.string().length(2).describe("ISO 2-letter country code"),
      language: z.string().length(2).describe("ISO 2-letter language code"),
      author: z.string().optional().describe("Job source: 'mol' or 'tmt'"),
      limit: z.union([z.string(), z.number()]).optional().describe("Max results (10-50, default 20)"),
      remove: z.string().optional().describe("Comma-separated keywords to exclude from results"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        action: "get_jobs_by_text",
        search: params.search,
        keywords: params.keywords,
        area: params.area,
        country: params.country,
        language: params.language,
      };
      if (params.author) payload.author = params.author;
      if (params.limit) payload.limit = Number(params.limit);
      if (params.remove) payload.remove = params.remove;

      const result = await headaiPost(apiKey,"Utils", payload);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Autocomplete Job Title ─────────────────────────────────────────────

server.registerTool(
  "headai_autocomplete_job_title",
  {
    title: "Autocomplete Job Title",
    description: `Autocomplete a job title based on partial text input.

Posts to /Utils with action "autocomplete_job_title". Returns matching job titles from Headai's ontology.
Useful for: finding the exact job title string to use with other tools, or building typeahead UIs.
If text is empty, lists all available job titles for the given language.

Args:
  - text (string, required): Partial job title to autocomplete (e.g. "software" or "ohjelmistoke")
  - language (string, required): ISO 639-1 two-letter language code (e.g. "en", "fi")

Returns: Array of matching job title strings.`,
    inputSchema: {
      text: z.string().describe("Partial job title text to autocomplete"),
      language: z.string().length(2).describe("ISO 639-1 language code (e.g. 'en', 'fi')"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await headaiPost(apiKey,"Utils", {
        action: "autocomplete_job_title",
        text: params.text,
        language: params.language,
      });
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Job Title Relations ────────────────────────────────────────────────

server.registerTool(
  "headai_job_title_relations",
  {
    title: "Job Title to Skills",
    description: `Get the skills associated with a job title.

Posts to /Utils with action "job_title_relations". Given a job title, returns the skills
required for that role with importance weights (1-10 scale).
Useful for: "What skills does a Software Developer need?" or building skill profiles from job titles.

Args:
  - text (string, required): Job title to look up (e.g. "ohjelmistokehittäjä", "software developer")
  - language (string, required): ISO 639-1 two-letter language code (e.g. "en", "fi")

Returns: Array of objects with skill name and weight (importance 1-10).`,
    inputSchema: {
      text: z.string().describe("Job title to get skills for"),
      language: z.string().length(2).describe("ISO 639-1 language code (e.g. 'en', 'fi')"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await headaiPost(apiKey,"Utils", {
        action: "job_title_relations",
        text: params.text,
        language: params.language,
      });
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Autocomplete Industry ──────────────────────────────────────────────

server.registerTool(
  "headai_autocomplete_industry",
  {
    title: "Autocomplete Industry",
    description: `Autocomplete an industry name based on partial text input.

Posts to /Utils with action "autocomplete_industry". Returns matching industries from Headai's ontology.
Useful for: finding the exact industry string to use with other tools, or building typeahead UIs.
If text is empty, lists all available industries for the given language.

Args:
  - text (string, required): Partial industry name to autocomplete (e.g. "auto" or "software")
  - language (string, required): ISO 639-1 two-letter language code (e.g. "en", "fi")

Returns: Array of matching industry name strings.`,
    inputSchema: {
      text: z.string().describe("Partial industry name to autocomplete"),
      language: z.string().length(2).describe("ISO 639-1 language code (e.g. 'en', 'fi')"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await headaiPost(apiKey,"Utils", {
        action: "autocomplete_industry",
        text: params.text,
        language: params.language,
      });
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Industry Relations ─────────────────────────────────────────────────

server.registerTool(
  "headai_industry_relations",
  {
    title: "Industry to Skills",
    description: `Get the skills associated with an industry.

Posts to /Utils with action "industry_relations". Given an industry, returns the skills
demanded in that industry with importance weights (1-10 scale).
Useful for: "What skills does the automotive industry need?" or mapping industries to skill requirements.

Args:
  - text (string, required): Industry name to look up (e.g. "Autoala", "software")
  - language (string, required): ISO 639-1 two-letter language code (e.g. "en", "fi")

Returns: Array of objects with skill name and weight (importance 1-10).`,
    inputSchema: {
      text: z.string().describe("Industry name to get skills for"),
      language: z.string().length(2).describe("ISO 639-1 language code (e.g. 'en', 'fi')"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await headaiPost(apiKey,"Utils", {
        action: "industry_relations",
        text: params.text,
        language: params.language,
      });
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Analyst Reports (formerly Junior) ─────────────────────────────────────

const QA_BASE_URL = process.env.HEADAI_QA_URL || "https://qa.headai.com:8081";

async function qaGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const response = await axios.get(`${QA_BASE_URL}/${endpoint}`, {
    params,
    timeout: 320000, // analyst reports can take a while
  });
  return response.data as T;
}

async function qaPost<T>(endpoint: string, data: Record<string, unknown>): Promise<T> {
  const response = await axios.post(`${QA_BASE_URL}/${endpoint}`, data, {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    timeout: 320000,
  });
  return response.data as T;
}

server.registerTool(
  "headai_run_analyst",
  {
    title: "Run Analytical Report",
    description: `Run an analytical report on a Headai knowledge graph, scorecard, or signals output.

Analyst reports extract structured insights from graphs — most connected concepts, gap analysis,
trend detection, strategic overviews, and more. Each report type is designed for a specific
kind of input (graph, scorecard, or signals).

Graph reports (input: any knowledge graph):
  1=Most connected concepts, 3=Most significant group, 4=Top groups by weight,
  5=Weakest groups, 6=Strongest concept pairs, 7=Strongest bridging concepts,
  8=Hidden strengths, 9=Wide but weak, 10=Outlier concepts,
  15=Strategic overview (LLM), 999=Data Insight Report

Scorecard reports (input: scorecard output):
  300=Quick Opportunities (composite), 301=Strongest common concepts,
  305=Cross-group hubs, 308=Low-hanging fruits, 309=Gap report

Signal reports (input: signals output):
  400=Signal Quick Opportunities, 401=Emerging hubs, 406=Decline watch,
  408=Opposing forces

Composite/strategic:
  100=Legacy Overview, 102=Strategic Overview, 200=Full Legacy Report

Mode flags (bitmask, combine with +):
  1=USE_GPT, 256=PLAIN_TEXT, 512=JSON_OUTPUT, 1024=TOP100
  Recommended: 1280 (PLAIN+TOP100). For LLM reports (13,14,15): use mode=1.

Args:
  - url (string, required): URL of the graph/scorecard/signals to analyze
  - report (number, required): Report type ID (see list above)
  - mode (number, optional): Mode bitmask. Default: 1280 (PLAIN+TOP100)
  - output (string, optional): Output format — "plain" for plain text
  - domain (string, optional): Industry/domain context for the analysis`,
    inputSchema: {
      url: z.string().url().describe("URL of the Headai graph to analyze"),
      report: z.number().int().describe("Report type ID (e.g. 1, 300, 400, 999)"),
      mode: z.number().int().optional().default(1280).describe("Mode bitmask. Default 1280 (PLAIN+TOP100). LLM reports: use 1"),
      output: z.string().optional().describe("Output format — 'plain' for plain text"),
      domain: z.string().optional().describe("Industry/domain context for analysis"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const queryParams: Record<string, string> = {
        url: params.url,
        report: String(params.report),
        mode: String(params.mode),
      };
      if (params.output) queryParams.output = params.output;
      if (params.domain) queryParams.domain = params.domain;

      const result = await qaGet<string>("run-junior", queryParams);
      // run-junior returns plain text, not JSON
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

server.registerTool(
  "headai_run_composer",
  {
    title: "Generate Strategic Composer Report",
    description: `Generate a full strategic Composer report from Headai graphs.

Composer produces a comprehensive strategic document with executive summary,
key findings, detailed analysis sections, and recommendations. This is the
most thorough analytical output available.

It takes up to 3 graph/scorecard/signals URLs and a prompt describing what
to analyze. Internally it runs multiple Analyst sub-reports and then
synthesizes them into a cohesive HTML document.

Args:
  - json1 (string, required): URL of the first graph to analyze
  - json2 (string, optional): URL of the second graph (e.g., for comparison)
  - json3 (string, optional): URL of the third graph (e.g., scorecard of json1 vs json2)
  - prompt (string, required): Analysis instructions / what to focus on
  - mode (number, optional): 0=instruction-only (default), 1=full prompt to LLM
  - domain (string, optional): Industry/domain context for the analysis`,
    inputSchema: {
      json1: z.string().url().describe("URL of the first Headai graph"),
      json2: z.string().url().optional().describe("URL of the second graph (optional)"),
      json3: z.string().url().optional().describe("URL of the third graph (optional, e.g. scorecard)"),
      prompt: z.string().describe("Analysis instructions — what to focus on in the report"),
      mode: z.number().int().optional().default(0).describe("0=instruction-only (default), 1=full prompt to LLM"),
      domain: z.string().optional().describe("Industry/domain context"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const payload: Record<string, unknown> = {
        json1: params.json1,
        prompt: params.prompt,
        mode: params.mode,
      };
      if (params.json2) payload.json2 = params.json2;
      if (params.json3) payload.json3 = params.json3;
      if (params.domain) payload.domain = params.domain;

      const result = await qaPost<string>("composer", payload);
      // composer returns HTML
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Describe Graph (human-readable summary) ────────────────────────

server.registerTool(
  "headai_describe_graph",
  {
    title: "Describe Knowledge Graph",
    description: `Get a human-readable text description of a Headai knowledge graph.

Given a graph URL, returns a natural language summary of what the graph contains —
dataset, search parameters, number of nodes, key concepts, and the original API call
that produced it. Useful for understanding any graph without reading raw JSON.

Args:
  - url (string, required): Full URL to the graph JSON (on megatron.headai.com/analysis/...)`,
    inputSchema: {
      url: z.string().url().describe("URL of the Headai graph to describe"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const response = await axios.get(`${API_BASE_URL}/mc_api`, {
        params: {
          action: "BuildKnowledgeGraph_API_call_to_text",
          url: params.url,
        },
        headers: { Authorization: apiKey },
        timeout: 30000,
      });
      const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: List Token Endpoints ───────────────────────────────────────────

server.registerTool(
  "headai_list_token_endpoints",
  {
    title: "List API Key Endpoints",
    description: `List all API endpoints/methods available for the current API key.

Shows which Headai endpoints have been used or are accessible with this API key,
including stored long queries and configured data sources.

Returns: List of endpoints and their status for this API key.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/Utils`, {
        params: {
          action: "get_token_endpoints",
          token: apiKey,
        },
        headers: { Authorization: apiKey },
        timeout: 30000,
      });
      const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: List Token Data ────────────────────────────────────────────────

server.registerTool(
  "headai_list_token_data",
  {
    title: "List Data for Endpoint",
    description: `List all data (graphs, scorecards, signals, etc.) built with the current API key for a specific endpoint.

Shows all results/artifacts that have been calculated with this API key for the given
endpoint. Use headai_list_token_endpoints first to see which endpoints are available.

Args:
  - endpoint (string, required): The endpoint/API call to list data for (e.g., "BuildKnowledgeGraph", "Scorecard", "BuildSignals", "Compass")`,
    inputSchema: {
      endpoint: z.string().describe("Endpoint to list data for (e.g., 'BuildKnowledgeGraph', 'Scorecard', 'BuildSignals')"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const response = await axios.get(`${API_BASE_URL}/Utils`, {
        params: {
          action: "get_token_data",
          token: apiKey,
          endpoint: params.endpoint,
        },
        headers: { Authorization: apiKey },
        timeout: 30000,
      });
      const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
      return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Estimate Graph Size ────────────────────────────────────────────

server.registerTool(
  "headai_estimate_size",
  {
    title: "Estimate Graph Size",
    description: `Estimate the size of a BuildKnowledgeGraph result before actually building it.

Use this to check how many documents/records match your query parameters without
spending time on a full graph build. Helps you calibrate the 'size' parameter
and verify that a dataset has data for your search criteria.

Takes the same parameters as BuildKnowledgeGraph (dataset, search_text, language, etc.)
and returns an estimate of how many matching records exist.

Args:
  - dataset (string, required): Dataset name — "job_ads", "doaj_articles", "curriculum", "theseus", "investment_data", "news"
  - search_text (string): Keywords to filter (same format as BKG: hyphens=AND, commas=OR)
  - language (string): Language code (default: "en"). Required for doaj_articles, investment_data, news.
  - ontology (string): Ontology — "headai", "esco", "lightcast" (default: "headai")
  - search_year (number): Year filter. Required for doaj_articles, investment_data, news.
  - country (string): Country code filter (e.g., "fi"). Mutually exclusive with city.
  - city (string): City name filter (e.g., "Helsinki"). Mutually exclusive with country.`,
    inputSchema: {
      dataset: z.string().describe("Dataset: job_ads, doaj_articles, curriculum, theseus, investment_data, news"),
      search_text: z.string().optional().describe("Keywords to filter"),
      language: z.string().optional().default("en").describe("Language code"),
      ontology: z.string().optional().default("headai").describe("Ontology: headai, esco, lightcast"),
      search_year: z.union([z.string(), z.number()]).optional().describe("Year filter (required for doaj_articles, investment_data, news)"),
      country: z.string().optional().describe("Country code filter"),
      city: z.string().optional().describe("City name filter"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const queryParams: Record<string, string> = {
        action: "BuildKnowledgeGraph_estimate",
        token: apiKey,
        dataset: params.dataset,
        language: params.language || "en",
        ontology: params.ontology || "headai",
      };
      if (params.search_text) queryParams.search_text = params.search_text;
      if (params.search_year !== undefined) queryParams.search_year = String(params.search_year);
      if (params.country) queryParams.country = params.country;
      if (params.city) queryParams.city = params.city;

      const response = await axios.get(`${API_BASE_URL}/Utils`, {
        params: queryParams,
        headers: { Authorization: apiKey },
        timeout: 30000,
      });
      const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

return server;
} // end createServer()

// Global server instance for stdio mode
const server = createServer();

// ── Docs HTML ─────────────────────────────────────────────────────────────

function getDocsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Headai MCP Server — Connect AI Agents to Workforce Intelligence</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a2e; background: #f8f9fa; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #16213e; }
    h2 { font-size: 1.4rem; margin: 2rem 0 1rem; color: #16213e; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    h3 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; color: #2d3748; }
    p { margin-bottom: 1rem; color: #4a5568; }
    .subtitle { font-size: 1.1rem; color: #718096; margin-bottom: 2rem; }
    .badge { display: inline-block; background: #48bb78; color: white; padding: 0.25rem 0.75rem; border-radius: 1rem; font-size: 0.85rem; margin-right: 0.5rem; }
    .badge.blue { background: #4299e1; }
    .badge.purple { background: #805ad5; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #e2e8f0; }
    th { background: #edf2f7; font-weight: 600; }
    tr:hover { background: #f7fafc; }
    code { background: #edf2f7; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.9rem; }
    pre { background: #1a1a2e; color: #e2e8f0; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 1rem 0; }
    pre code { background: none; color: inherit; padding: 0; }
    .endpoint { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; }
    .endpoint .method { font-weight: 700; color: #48bb78; margin-right: 0.5rem; }
    .endpoint .method.post { color: #ed8936; }
    .endpoint .method.delete { color: #fc8181; }
    .links a { display: inline-block; margin-right: 1.5rem; color: #4299e1; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin: 1rem 0; }
    ul { margin: 0.5rem 0 1rem 1.5rem; }
    li { margin-bottom: 0.4rem; color: #4a5568; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Headai MCP Server</h1>
    <p class="subtitle">Connect AI agents to workforce intelligence — knowledge graphs, skills analysis, trend signals, and career recommendations from 150M+ data points.</p>
    <div style="margin-bottom:2rem">
      <span class="badge">23 Tools</span>
      <span class="badge blue">Read-only</span>
      <span class="badge purple">Streamable HTTP</span>
    </div>

    <h2>Overview</h2>
    <p>Headai MCP Server is a Model Context Protocol server that connects AI agents — Claude, Cursor, GitHub Copilot, or any MCP client — to Headai's Core Engine APIs. Build knowledge graphs from job ads, research articles, investment data, and more. Compare skills, detect trends, and get AI-powered career recommendations.</p>
    <p>A Headai API key is required. Contact <a href="https://headai.com">headai.com</a> for access.</p>

    <h2>Server Endpoints</h2>
    <div class="endpoint"><span class="method post">POST</span><code>/mcp</code> — MCP protocol (JSON-RPC 2.0, Streamable HTTP)</div>
    <div class="endpoint"><span class="method">GET</span><code>/mcp</code> — SSE stream for active sessions</div>
    <div class="endpoint"><span class="method delete">DELETE</span><code>/mcp</code> — Session termination</div>
    <div class="endpoint"><span class="method">GET</span><code>/health</code> — Server health check</div>
    <div class="endpoint"><span class="method">GET</span><code>/docs</code> — This documentation page</div>
    <div class="endpoint"><span class="method">GET</span><code>/tools</code> — Tool listing (JSON)</div>
    <div class="endpoint"><span class="method">GET</span><code>/changelog</code> — Release history</div>

    <h2>Available Tools</h2>
    <table>
      <thead><tr><th>Tool</th><th>Category</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>headai_text_to_graph</code></td><td>Core</td><td>Convert text into a semantic knowledge graph</td></tr>
        <tr><td><code>headai_text_to_keywords</code></td><td>Core</td><td>Extract weighted keywords from text</td></tr>
        <tr><td><code>headai_build_knowledge_graph</code></td><td>Core</td><td>Build graphs from datasets (job ads, articles, curricula, investment, news)</td></tr>
        <tr><td><code>headai_scorecard</code></td><td>Analysis</td><td>Compare two knowledge graphs — gap analysis, coverage scoring</td></tr>
        <tr><td><code>headai_compass</code></td><td>Recommendations</td><td>AI-powered recommendations (jobs, courses, skills, career paths)</td></tr>
        <tr><td><code>headai_build_signals</code></td><td>Trends</td><td>Time series trend analysis — emerging, growing, declining skills</td></tr>
        <tr><td><code>headai_join_graphs</code></td><td>Transform</td><td>Merge multiple knowledge graphs</td></tr>
        <tr><td><code>headai_modify_graph</code></td><td>Transform</td><td>Filter/refine a graph by group, weight, or keywords</td></tr>
        <tr><td><code>headai_translate_graph</code></td><td>Transform</td><td>Translate a graph between languages</td></tr>
        <tr><td><code>headai_digital_twin</code></td><td>Storage</td><td>Store/retrieve competency profiles</td></tr>
        <tr><td><code>headai_fetch_graph</code></td><td>Utility</td><td>Retrieve a graph by URL</td></tr>
        <tr><td><code>headai_fetch_and_save</code></td><td>Utility</td><td>Fetch a graph and save to local file</td></tr>
        <tr><td><code>headai_describe_graph</code></td><td>Utility</td><td>Get human-readable description of a graph</td></tr>
        <tr><td><code>headai_estimate_size</code></td><td>Utility</td><td>Estimate result size before building</td></tr>
        <tr><td><code>headai_list_token_endpoints</code></td><td>Admin</td><td>List API endpoints for your key</td></tr>
        <tr><td><code>headai_list_token_data</code></td><td>Admin</td><td>List data built with your key</td></tr>
        <tr><td><code>headai_get_jobs_by_text</code></td><td>Jobs</td><td>Find matching job listings</td></tr>
        <tr><td><code>headai_autocomplete_job_title</code></td><td>Jobs</td><td>Autocomplete job titles</td></tr>
        <tr><td><code>headai_job_title_relations</code></td><td>Jobs</td><td>Get skills related to a job title</td></tr>
        <tr><td><code>headai_autocomplete_industry</code></td><td>Jobs</td><td>Autocomplete industries</td></tr>
        <tr><td><code>headai_industry_relations</code></td><td>Jobs</td><td>Get skills related to an industry</td></tr>
        <tr><td><code>headai_run_analyst</code></td><td>Reports</td><td>Run automated QA/analysis reports</td></tr>
        <tr><td><code>headai_run_composer</code></td><td>Reports</td><td>Generate strategic HTML documents</td></tr>
      </tbody>
    </table>

    <h2>Authentication</h2>
    <div class="card">
      <h3>API Keys</h3>
      <p>Format: <code>Authorization: Bearer your_headai_api_key</code></p>
      <ul>
        <li>Provide your Headai API key as a Bearer token</li>
        <li>Each user uses their own API key — the server is a stateless proxy</li>
        <li>All 23 tools are available based on key permissions</li>
        <li>Contact <a href="https://headai.com">headai.com</a> for API key provisioning</li>
      </ul>
    </div>

    <h2>Setup</h2>
    <h3>Claude Desktop / Claude Code (stdio)</h3>
    <pre><code>{
  "mcpServers": {
    "headai": {
      "command": "node",
      "args": ["/path/to/headai-mcp-server/dist/index.js"],
      "env": {
        "HEADAI_API_KEY": "your_api_key_here"
      }
    }
  }
}</code></pre>

    <h3>Remote (Streamable HTTP)</h3>
    <pre><code>MCP Server URL: https://mcp.headai.dev/mcp
Authorization: Bearer your_headai_api_key</code></pre>

    <h2>Usage Examples</h2>
    <div class="card">
      <h3>1. Build a knowledge graph from job ads</h3>
      <p><em>"What AI skills are Finnish employers looking for right now?"</em></p>
      <p>Uses <code>headai_build_knowledge_graph</code> with dataset <code>job_ads</code>, country <code>fi</code>, and AI-related search terms. Returns ranked skills with weights and connections.</p>
    </div>
    <div class="card">
      <h3>2. Compare curriculum vs. job market</h3>
      <p><em>"Compare our data science curriculum against what employers need"</em></p>
      <p>Build two snapshots, then use <code>headai_scorecard</code> to get coverage %, matched skills, gaps, and surplus.</p>
    </div>
    <div class="card">
      <h3>3. Detect trending skills over time</h3>
      <p><em>"How have cybersecurity skills evolved from 2022 to 2025?"</em></p>
      <p>Build yearly snapshots, then <code>headai_build_signals</code> classifies skills into 8 groups: Emerging, Growing, Constant, Declining, Disappearing.</p>
    </div>
    <div class="card">
      <h3>4. Cross-source horizon analysis</h3>
      <p><em>"What does the future look like for autonomous vehicles?"</em></p>
      <p>Combine <code>job_ads</code> (now) → <code>investment_data</code> (1-3yr) → <code>doaj_articles</code> (5-10yr) into signals.</p>
    </div>
    <div class="card">
      <h3>5. Career recommendations</h3>
      <p><em>"I know Python and SQL. What should I learn next for data engineering?"</em></p>
      <p>Use <code>headai_compass</code> for personalized skill recommendations based on Zone of Proximal Development.</p>
    </div>

    <h2>Troubleshooting</h2>
    <h3>Authentication Failures</h3>
    <ul>
      <li>Verify your API key is valid and not expired</li>
      <li>Ensure Authorization header includes <code>Bearer</code> prefix</li>
      <li>Check key has permissions for the requested endpoint</li>
    </ul>
    <h3>Empty Results from BuildKnowledgeGraph</h3>
    <ul>
      <li><code>doaj_articles</code>, <code>investment_data</code>, <code>news</code> datasets require <code>search_year</code> parameter</li>
      <li>Use <code>headai_estimate_size</code> to check data availability before building</li>
      <li>Verify search_text uses vocabulary matching the dataset type</li>
    </ul>
    <h3>Slow Responses</h3>
    <ul>
      <li>Large graphs (size &gt; 500) take longer — use <code>headai_estimate_size</code> first</li>
      <li>Compass has a 320s timeout due to intensive computation</li>
      <li>Max 1 concurrent Compass request per API key (2 cores per key)</li>
    </ul>

    <h2>Links</h2>
    <div class="links">
      <a href="https://headai.com">Headai Website</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="mailto:support@headai.com">Support</a>
    </div>
    <p style="margin-top:2rem;color:#a0aec0;font-size:0.85rem">&copy; 2026 Headai Ltd. All rights reserved.</p>
  </div>
</body>
</html>`;
}

function getPageShell(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Headai MCP Server</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.7; color: #1a1a2e; background: #f8f9fa; }
    .container { max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.8rem; margin-bottom: 1.5rem; color: #16213e; }
    h2 { font-size: 1.3rem; margin: 1.8rem 0 0.8rem; color: #16213e; }
    p { margin-bottom: 1rem; color: #4a5568; }
    ul { margin: 0.5rem 0 1rem 1.5rem; }
    li { margin-bottom: 0.4rem; color: #4a5568; }
    a { color: #4299e1; }
    .back { display: inline-block; margin-bottom: 1.5rem; color: #4299e1; text-decoration: none; }
    .updated { color: #a0aec0; font-size: 0.85rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/docs" class="back">&larr; Back to documentation</a>
    ${content}
  </div>
</body>
</html>`;
}

function getPrivacyHtml(): string {
  return getPageShell("Privacy Policy", `
    <h1>Privacy Policy</h1>
    <p><strong>Headai MCP Server</strong> — operated by Headai Ltd.</p>
    <p><em>Last updated: April 2026</em></p>

    <h2>What data we collect</h2>
    <p>The Headai MCP Server acts as a stateless proxy between your MCP client and Headai's Core Engine. We process:</p>
    <ul>
      <li><strong>API key</strong> — provided by you in the Authorization header. Used solely to authenticate requests to the Headai Core Engine. Not stored on the MCP server.</li>
      <li><strong>Request payloads</strong> — text, search parameters, and graph URLs you send to the tools. Forwarded to the Headai Core Engine for processing.</li>
      <li><strong>Server logs</strong> — session IDs and timestamps for operational monitoring. No request content is logged.</li>
    </ul>

    <h2>How we use your data</h2>
    <ul>
      <li>To process your tool requests via the Headai Core Engine</li>
      <li>To monitor server health and diagnose errors</li>
      <li>We do not sell, share, or use your data for advertising</li>
    </ul>

    <h2>Data processing by Headai Core Engine</h2>
    <p>Text submitted to tools like <code>headai_text_to_graph</code> and <code>headai_text_to_keywords</code> is processed by Headai's AI engine (Graphmind). By default, input text may be temporarily stored for processing. Knowledge graphs and analysis results are stored under your API key and can be listed or deleted via the API.</p>

    <h2>Data retention</h2>
    <ul>
      <li>The MCP server itself stores no persistent data — it is stateless</li>
      <li>Results (graphs, scorecards, signals) stored on the Headai Core Engine are retained under your API key until you delete them</li>
      <li>Server logs are retained for up to 30 days</li>
    </ul>

    <h2>Your rights</h2>
    <p>You can request access to, correction of, or deletion of your data by contacting <a href="mailto:support@headai.com">support@headai.com</a>. Under GDPR, you have the right to data portability and the right to lodge a complaint with a supervisory authority.</p>

    <h2>Contact</h2>
    <p>Headai Ltd.<br>Email: <a href="mailto:support@headai.com">support@headai.com</a><br>Website: <a href="https://headai.com">headai.com</a></p>
    <p class="updated">This privacy policy applies specifically to the Headai MCP Server at mcp.headai.dev.</p>
  `);
}

function getTermsHtml(): string {
  return getPageShell("Terms of Service", `
    <h1>Terms of Service</h1>
    <p><strong>Headai MCP Server</strong> — operated by Headai Ltd.</p>
    <p><em>Last updated: April 2026</em></p>

    <h2>1. Service description</h2>
    <p>The Headai MCP Server provides a Model Context Protocol interface to Headai's Core Engine APIs for workforce intelligence, skills analysis, and knowledge graph operations. The server acts as a stateless proxy — your API key authenticates directly with the Headai Core Engine.</p>

    <h2>2. Account and API key</h2>
    <ul>
      <li>A valid Headai API key is required to use this service</li>
      <li>You are responsible for keeping your API key confidential</li>
      <li>You must not share your API key or use another user's key without authorization</li>
      <li>Headai may revoke API keys that are misused or compromised</li>
    </ul>

    <h2>3. Acceptable use</h2>
    <p>You agree to use the service in compliance with applicable laws and not to:</p>
    <ul>
      <li>Attempt to circumvent rate limits or authentication</li>
      <li>Use the service to process illegal or harmful content</li>
      <li>Reverse engineer the Headai Core Engine or its algorithms</li>
      <li>Redistribute Headai data or analysis results without permission</li>
    </ul>

    <h2>4. Intellectual property</h2>
    <p>Data you submit remains yours. Knowledge graphs, scorecards, signals, and other outputs generated from your data are owned by you. Headai retains rights to the underlying algorithms, models, and ontologies.</p>

    <h2>5. Service availability</h2>
    <p>We aim for high availability but do not guarantee uninterrupted service. The Headai Core Engine has capacity limits (2 cores per API key). We may introduce usage limits, rate limiting, or maintenance windows with reasonable notice.</p>

    <h2>6. Limitation of liability</h2>
    <p>The service is provided "as is" without warranties of any kind. Headai is not liable for any indirect, incidental, or consequential damages arising from use of the service. Our total liability is limited to the fees paid for the service in the preceding 12 months.</p>

    <h2>7. Changes to terms</h2>
    <p>We may update these terms with reasonable notice. Continued use of the service after changes take effect constitutes acceptance of the updated terms.</p>

    <h2>8. Governing law</h2>
    <p>These terms are governed by the laws of Finland. Disputes shall be resolved in the courts of Helsinki, Finland.</p>

    <h2>Contact</h2>
    <p>Headai Ltd.<br>Email: <a href="mailto:support@headai.com">support@headai.com</a><br>Website: <a href="https://headai.com">headai.com</a></p>
    <p class="updated">These terms apply specifically to the Headai MCP Server at mcp.headai.dev.</p>
  `);
}

// ── Main ───────────────────────────────────────────────────────────────────

const TRANSPORT_MODE = process.env.MCP_TRANSPORT || "stdio"; // "stdio" or "http"
const HTTP_PORT = parseInt(process.env.PORT || process.env.MCP_PORT || "3000", 10);
const HTTP_HOST = process.env.MCP_HOST || "0.0.0.0";

async function main() {
  if (TRANSPORT_MODE === "stdio" && !DEFAULT_API_KEY) {
    console.error("WARNING: HEADAI_API_KEY environment variable is not set. All API calls will fail with 401.");
    console.error("Set it with: export HEADAI_API_KEY=your_key_here");
  }

  if (TRANSPORT_MODE === "http") {
    await startHttpServer();
  } else {
    await startStdioServer();
  }
}

// ── Stdio transport (local development, Claude Desktop) ──────────────────

async function startStdioServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Headai MCP server running via stdio");
}

// ── Streamable HTTP transport (remote, MCP Directory) ────────────────────

async function startHttpServer() {
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS
    ? process.env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim())
    : undefined;

  const app = createMcpExpressApp({
    host: HTTP_HOST,
    ...(allowedHosts && { allowedHosts }),
  });

  // CORS for browser clients (claude.ai)
  app.use((_req: any, res: any, next: any) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, Last-Event-ID");
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Session management
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionApiKeys: Record<string, string> = {};

  /** Extract API key from Authorization: Bearer <key> header */
  function extractApiKey(req: any): string {
    const authHeader = req.headers["authorization"] as string | undefined;
    if (authHeader) {
      // Support: "Bearer <key>" or plain "<key>"
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) return match[1];
      // Also accept "API-key <key>" format
      const apiKeyMatch = authHeader.match(/^API-key\s+(.+)$/i);
      if (apiKeyMatch) return apiKeyMatch[1];
      return authHeader; // plain key
    }
    return DEFAULT_API_KEY; // fallback to env var (stdio compat)
  }

  // Health check
  app.get("/health", (_req: any, res: any) => {
    res.json({
      status: "ok",
      server: "headai-mcp-server",
      version: "1.0.0",
      tools: 23,
      transport: "streamable-http",
    });
  });

  // Documentation landing page (like Supermetrics /docs)
  app.get("/", (_req: any, res: any) => {
    res.redirect("/docs");
  });

  app.get("/docs", (_req: any, res: any) => {
    res.type("html").send(getDocsHtml());
  });

  // Tool listing endpoint
  app.get("/tools", (_req: any, res: any) => {
    res.json({
      server: "headai-mcp-server",
      version: "1.0.0",
      tool_count: 23,
      tools: [
        { name: "headai_text_to_graph", category: "Core", description: "Convert text into a semantic knowledge graph" },
        { name: "headai_text_to_keywords", category: "Core", description: "Extract weighted keywords from text" },
        { name: "headai_build_knowledge_graph", category: "Core", description: "Build graphs from datasets (job ads, articles, curricula, investment, news)" },
        { name: "headai_scorecard", category: "Analysis", description: "Compare two knowledge graphs — gap analysis, coverage scoring" },
        { name: "headai_compass", category: "Recommendations", description: "AI-powered recommendations (jobs, courses, skills)" },
        { name: "headai_build_signals", category: "Trends", description: "Time series trend analysis — emerging, growing, declining skills" },
        { name: "headai_join_graphs", category: "Transform", description: "Merge multiple knowledge graphs" },
        { name: "headai_modify_graph", category: "Transform", description: "Filter/refine a graph by group, weight, or keywords" },
        { name: "headai_translate_graph", category: "Transform", description: "Translate a graph between languages" },
        { name: "headai_digital_twin", category: "Storage", description: "Store/retrieve competency profiles" },
        { name: "headai_fetch_graph", category: "Utility", description: "Retrieve a graph by URL" },
        { name: "headai_fetch_and_save", category: "Utility", description: "Fetch a graph and save to local file" },
        { name: "headai_describe_graph", category: "Utility", description: "Get human-readable description of a graph" },
        { name: "headai_estimate_size", category: "Utility", description: "Estimate result size before building" },
        { name: "headai_list_token_endpoints", category: "Admin", description: "List API endpoints available for your key" },
        { name: "headai_list_token_data", category: "Admin", description: "List all data built with your key" },
        { name: "headai_get_jobs_by_text", category: "Jobs", description: "Find matching job listings" },
        { name: "headai_autocomplete_job_title", category: "Jobs", description: "Autocomplete job titles" },
        { name: "headai_job_title_relations", category: "Jobs", description: "Get skills related to a job title" },
        { name: "headai_autocomplete_industry", category: "Jobs", description: "Autocomplete industries" },
        { name: "headai_industry_relations", category: "Jobs", description: "Get skills related to an industry" },
        { name: "headai_run_analyst", category: "Reports", description: "Run automated QA/analysis reports" },
        { name: "headai_run_composer", category: "Reports", description: "Generate strategic HTML documents" },
      ],
    });
  });

  // Changelog endpoint
  app.get("/changelog", (_req: any, res: any) => {
    res.json({
      changelog: [
        {
          version: "1.0.0",
          date: "2026-04-02",
          changes: [
            "Initial release with 23 tools",
            "Dual transport: stdio + Streamable HTTP",
            "Bearer token authentication (user-provided API key)",
            "Safety annotations on all tools",
            "5 datasets: job_ads, doaj_articles, curriculum, investment_data, news",
            "Async polling for BuildKnowledgeGraph and BuildSignals",
            "Graph visualization via cloud.headai.com Visualizer",
          ],
        },
      ],
    });
  });

  // Privacy policy page
  app.get("/privacy", (_req: any, res: any) => {
    res.type("html").send(getPrivacyHtml());
  });

  // Terms of service page
  app.get("/terms", (_req: any, res: any) => {
    res.type("html").send(getTermsHtml());
  });

  // MCP POST endpoint
  app.post("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session — extract API key from Bearer token
        const callerApiKey = extractApiKey(req);
        if (!callerApiKey) {
          res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unauthorized: Provide your Headai API key as Authorization: Bearer <your_key>" },
            id: null,
          });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            console.log(`Session initialized: ${sid} (key: ${callerApiKey.slice(0, 4)}...)`);
            transports[sid] = transport;
            sessionApiKeys[sid] = callerApiKey;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            console.log(`Session closed: ${sid}`);
            delete transports[sid];
            delete sessionApiKeys[sid];
          }
        };

        // Each session gets its own server with the caller's API key
        const sessionServer = createServer(callerApiKey);
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP POST:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // MCP GET endpoint (SSE streams)
  app.get("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // MCP DELETE endpoint (session termination)
  app.delete("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(HTTP_PORT, HTTP_HOST, () => {
    console.log(`Headai MCP server (Streamable HTTP) listening on ${HTTP_HOST}:${HTTP_PORT}`);
    console.log(`  Health: http://${HTTP_HOST}:${HTTP_PORT}/health`);
    console.log(`  MCP:    http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    for (const sid in transports) {
      try {
        await transports[sid].close();
        delete transports[sid];
      } catch (e) {
        console.error(`Error closing session ${sid}:`, e);
      }
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
