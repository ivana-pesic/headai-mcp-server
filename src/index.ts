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
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import axios, { AxiosError } from "axios";
import * as fs from "fs";
import * as path from "path";
// Note: express is imported internally by @modelcontextprotocol/sdk
// We avoid importing it separately to prevent Express 4/5 version conflicts

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE_URL = process.env.HEADAI_API_URL || "https://megatron.headai.com";
const DEFAULT_API_KEY = process.env.HEADAI_API_KEY || "";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 120; // 6 minutes max
const CHARACTER_LIMIT = 25000;
const PREVIEW_SECRET = process.env.HEADAI_PREVIEW_SECRET || "headai-gate-2026";
const MIN_APPROVAL_DELAY_MS = 3000; // 3 seconds — for destructive operations (Digital Twin writes)
const MIN_APPROVAL_DELAY_BKG_MS = 0; // No delay for read-only BKG — prevents Claude.ai tool-use limit exhaustion

// ── Confirmation gate: hash-based enforcement + time lock ────────────────
// The server generates a preview_hash and remembers WHEN it was issued.
// The hash is only accepted after MIN_APPROVAL_DELAY_MS has passed,
// ensuring a real human had time to review the parameters.
// This prevents Claude from auto-approving in the same turn.

const previewTimestamps = new Map<string, number>(); // hash → timestamp

function computePreviewHash(params: Record<string, unknown>): string {
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return createHash("sha256").update(canonical + PREVIEW_SECRET).digest("hex").slice(0, 16);
}

function registerPreviewHash(hash: string): void {
  previewTimestamps.set(hash, Date.now());
  // Clean up old entries (older than 10 minutes)
  const cutoff = Date.now() - 600000;
  for (const [h, t] of previewTimestamps) {
    if (t < cutoff) previewTimestamps.delete(h);
  }
}

// ── Language-keyword mismatch detection ──────────────────────────────────
// Detects when search_text language doesn't match the language parameter

function detectLanguageMismatch(language: string, searchText: string): string | null {
  if (!searchText || searchText.trim().length === 0) return null;

  const keywords = searchText.split(",").map(k => k.trim().toLowerCase()).filter(k => k.length > 0);
  if (keywords.length === 0) return null;

  // Finnish indicators: ä, ö, common Finnish suffixes
  const finnishPatterns = /[äö]|suunnittelu|hallinta|kehitys|johtaminen|palvelu|tuote|käyttö|tietojenkäsittely|liiketoiminta|viestintä|analytiikka|ohjelmisto|pilvi|tekoäly|kone|oppiminen|turvallisuus|automaatio/i;
  // English indicators: common English words in tech/business
  const englishPatterns = /\b(management|design|development|engineering|strategy|research|testing|planning|analytics|software|cloud|machine learning|artificial|intelligence|security|automation|leadership|communication|stakeholder|agile|sprint|backlog|roadmap|prototyping|wireframing|usability)\b/i;

  const finnishCount = keywords.filter(k => finnishPatterns.test(k)).length;
  const englishCount = keywords.filter(k => englishPatterns.test(k)).length;

  if (language === "fi" && englishCount > finnishCount && englishCount >= 3) {
    return `Language "fi" selected but keywords appear English (${englishCount} English vs ${finnishCount} Finnish). Change language to "en" or translate keywords to Finnish.`;
  }

  if (language === "en" && finnishCount > englishCount && finnishCount >= 3) {
    return `Language "en" selected but keywords appear Finnish (${finnishCount} Finnish vs ${englishCount} English). Change language to "fi" or translate keywords to English.`;
  }

  return null;
}

function isHashReady(hash: string): { ready: boolean; waitSeconds: number } {
  const issued = previewTimestamps.get(hash);
  if (!issued) return { ready: false, waitSeconds: 0 }; // unknown hash
  const elapsed = Date.now() - issued;
  if (elapsed >= MIN_APPROVAL_DELAY_MS) return { ready: true, waitSeconds: 0 };
  return { ready: false, waitSeconds: Math.ceil((MIN_APPROVAL_DELAY_MS - elapsed) / 1000) };
}

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

    // Some endpoints (e.g. BuildSignals) return the final data directly at the
    // location URL without a "status" field once the job completes.
    // If status is no longer a string, the data is likely the finished result.
    if (typeof status !== "string") {
      return pollResponse.data;
    }
  }

  if (attempts >= MAX_POLL_ATTEMPTS) {
    throw new Error(`Job timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. Last status: ${status}. You can check the result later at: ${location}`);
  }

  return initialResponse;
}

// ── Error handling guardrail ──────────────────────────────────────────────
// Every error message ends with an instruction to the LLM to prevent
// hallucinated infrastructure diagnoses (e.g. "DNS cache overflow").
const ERROR_SUFFIX = "\n\n⚠️ IMPORTANT: Report this exact error to the user. Do NOT diagnose server infrastructure, invent error codes, or retry more than once. If the retry also fails, stop and show the user this error message.";

function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axErr = error as AxiosError;
    if (axErr.response) {
      const status = axErr.response.status;
      const data = axErr.response.data;
      switch (status) {
        case 401:
          return "Error: Unauthorized. Check your HEADAI_API_KEY is correct and not expired." + ERROR_SUFFIX;
        case 403:
          return "Error: Forbidden. Your API key may not have access to this endpoint." + ERROR_SUFFIX;
        case 404:
          return "Error: Endpoint not found. The API URL may be incorrect." + ERROR_SUFFIX;
        case 429:
          return "Error: Rate limit exceeded. Wait a moment and try again." + ERROR_SUFFIX;
        default:
          return `Error: Headai API returned ${status}. ${typeof data === "string" ? data : JSON.stringify(data)}` + ERROR_SUFFIX;
      }
    } else if (axErr.code === "ECONNABORTED") {
      return "Error: Request timed out. The operation may take longer — try with simpler parameters or smaller data." + ERROR_SUFFIX;
    }
    return `Error: Network issue — ${axErr.message}` + ERROR_SUFFIX;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}` + ERROR_SUFFIX;
}

function truncateIfNeeded(text: string): string {
  if (text.length > CHARACTER_LIMIT) {
    return text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use filters or smaller inputs to reduce output size]";
  }
  return text;
}

/**
 * Rewrite old Megatron visualizer URLs to the cloud.headai.com Visualizer.
 * The old map.html viewer is unreliable; the cloud Visualizer is the supported one.
 */
function fixVisualizerUrls(text: string): string {
  return text
    .replace(/https?:\/\/megatron\.headai\.com\/map\.html\?json_url=/g,
      "https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=")
    .replace(/https?:\/\/megatron\.headai\.com\/mapSeries\.html\?json_url=/g,
      "https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=");
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
// Creates a fresh McpServer instance with all 19 tools registered.
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
    description: `Convert free-form text into a structured semantic knowledge graph using Headai's AI.

WHEN TO USE: When the user pastes or provides text (CV, job description, article, strategy doc, course description) and wants to extract skills, concepts, or structure from it. This is the starting point for analyzing any user-provided text.

EXAMPLE CALLS:
  • User pastes a CV → text_to_graph(text: "<cv text>", language: "en", legend: "John's CV")
  • User pastes a job ad → text_to_graph(text: "<job ad>", language: "fi", legend: "Software Developer role")
  • Then use the returned graph URL in scorecard to compare CV vs job ad

WORKFLOW: text_to_graph → scorecard (compare) → compass (recommend)

Returns a knowledge graph with weighted concepts, clusters, and relationships. The graph URL can be fed into scorecard, compass, join_graphs, and other tools.

Args:
  - text (string, required): The text to analyze (any length)
  - language (string): ISO language code — "en", "fi", "sv", etc. (default: "en"). Match the text language.
  - ontology (string): Ontology to use (default: "headai")
  - legend (string): Label for the graph — use something descriptive like "Senior Developer CV"
  - word_type (string, optional): "only_compounds" for precise multi-word terms, leave empty for all
  - translate_to (string, optional): Translate output to another language
  - noise_list (string, optional): Comma-separated keywords to exclude from results
  - use_stored_noise (boolean, optional): Use noise list stored for API key
  - high_privacy_mode (boolean): Keep as false (default). Setting true breaks downstream chaining.`,
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
      const text = fixVisualizerUrls(truncateIfNeeded(JSON.stringify(result, null, 2)));
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
    description: `Build a knowledge graph from real-world datasets (job ads, research, curricula, news, investments, theses).

Parameters: dataset (required), search_text (~20 domain keywords, comma-separated), language, country/city, size (50-500), search_year.

Datasets: job_ads (current market, country/city filter), doaj_articles (research, needs search_year+language), curriculum (Finnish education), news (needs search_year), investment_data (needs search_year), theseus (Finnish theses, affiliation filter), tiedejatutkimus (Finnish research portal research.fi — publications, funding, projects, researchers; needs search_year+language, supports affiliation).

Keywords: use domain-specific terms, hyphens=AND, commas=OR. Avoid generic words (experience, skills, collaboration).

Server-enforced preview gate: first call returns preview+hash, second call builds. Async operation, polls automatically.

Returns JSON with: graph_url, visualizer_url, top_skills, companies, cities, sample_sources.
Visualizer: https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=<graph_url>`,
    inputSchema: {
      dataset: z.string().describe("Dataset: job_ads, doaj_articles, curriculum, theseus, investment_data, news, tiedejatutkimus, imported"),
      language: z.string().default("en").describe("Language code"),
      ontology: z.string().default("headai").describe("Ontology: headai, esco, lightcast, yso, fibo"),
      search_text: z.string().optional().describe("~20 domain-specific keywords, comma-separated, ordered by importance. Hyphens=AND, commas=OR. Exclude generic terms (experience, skills, collaboration). Match vocabulary to dataset type."),
      legend: z.string().optional().describe("Label/description for the graph"),
      search_year: z.union([z.string(), z.number()]).optional().describe("Year filter (e.g., 2024). REQUIRED for doaj_articles, investment_data, news, tiedejatutkimus — empty returns 0 results!"),
      search_month: z.union([z.string(), z.number()]).optional().describe("Month filter (e.g., 3 or '03'). Use 0 for all months."),
      search_day: z.union([z.string(), z.number()]).optional().describe("Day filter (e.g., 15 or '15'). Use 0 for all days."),
      startDate: z.string().optional().describe("Start date YYYY-MM-DD for date range queries"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD for date range queries"),
      country: z.string().optional().describe("Country code (e.g., 'fi'). Mutually exclusive with city"),
      city: z.string().optional().describe("City name (e.g., 'Helsinki'). Mutually exclusive with country"),
      affiliation: z.string().optional().describe("Affiliation filter — ONLY for doaj_articles/theseus/tiedejatutkimus"),
      size: z.union([z.string(), z.number()]).default(50).describe("Sample size 1-1000. Default 50. Do NOT change this unless the user explicitly asks for more data."),
      word_type: z.string().optional().describe("'only_compounds' for compound words only, 'none' for all words"),
      weighted_search_output: z.boolean().optional().describe("Match search_text as cluster (job_ads only)"),
      additional_data: z.boolean().optional().describe("Add extra info like relations (Lightcast only)"),
      noise_list: z.string().optional().describe("Comma-separated keywords to exclude"),
      use_stored_noise: z.boolean().optional().describe("Use noise list stored for API key"),
      preview_hash: z.string().optional().describe("Leave empty on first call. The tool will return a preview + a hash. After the user approves, call again with the SAME parameters and this hash to proceed."),
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
      // CONFIRMATION GATE: hash-based enforcement
      // Build canonical params for hashing (excludes preview_hash itself)
      const gateParams: Record<string, unknown> = {
        dataset: params.dataset,
        search_text: params.search_text || "",
        language: params.language,
        country: params.country || "",
        city: params.city || "",
        search_year: params.search_year !== undefined ? Number(params.search_year) : 0,
        size: Number(params.size) || 50,
      };
      const expectedHash = computePreviewHash(gateParams);

      if (!params.preview_hash || params.preview_hash !== expectedHash) {
        // ═══════════════════════════════════════════════════════════════
        // CONFIRMATION GATE — dataset-specific mandatory questions
        // Server enforces size cap at 50 for preview
        // ═══════════════════════════════════════════════════════════════
        const previewSize = Math.min(Number(params.size) || 50, 50);
        const ds = params.dataset;

        // Build the preview object
        const preview: Record<string, string | number | boolean | undefined> = {
          dataset: ds,
          search_text: params.search_text || "(none)",
          language: params.language,
          country: params.country,
          city: params.city,
          search_year: params.search_year !== undefined ? Number(params.search_year) : undefined,
          search_month: params.search_month !== undefined ? Number(params.search_month) : undefined,
          size: previewSize,
          word_type: params.word_type,
          legend: params.legend,
        };
        const cleanPreview = Object.fromEntries(Object.entries(preview).filter(([_, v]) => v !== undefined));

        // ── Dataset-specific questions ──
        const questions: string[] = [];
        const blockers: string[] = [];

        // Detect Finnish context for smart language suggestion
        const finnishLocations = ["fi", "finland", "helsinki", "tampere", "turku", "oulu", "espoo", "vantaa", "jyväskylä", "kuopio", "lahti", "vaasa", "rovaniemi", "joensuu", "lappeenranta", "kouvola", "pori", "kajaani", "kotka", "mikkeli", "seinäjoki", "hämeenlinna", "rauma"];
        const locationLower = ((params.country || "") + " " + (params.city || "")).toLowerCase().trim();
        const isFinnishContext = finnishLocations.some(loc => locationLower.includes(loc));

        // UNIVERSAL: search terms — with quality check
        const searchTermCount = (params.search_text || "").split(",").filter(t => t.trim()).length;
        let searchTermNote = "";
        if (searchTermCount < 10) searchTermNote = " (only" + searchTermCount + " terms — aim for ~20 for better coverage)";
        if (searchTermCount > 25) searchTermNote = " (" + searchTermCount + " terms — consider narrowing to ~20)";
        if (!params.search_text) searchTermNote = " (none set — broad market scan, or suggest ~20 domain-specific terms)";

        // Build language suggestion text
        let langNote = "";
        if (ds !== "doaj_articles") {
          if (isFinnishContext && params.language === "en") {
            langNote = ` Note: Finnish location detected — most job ads in Finland are in Finnish. Consider language "fi" for better coverage.`;
          } else if (isFinnishContext && params.language === "fi") {
            langNote = ` (Finnish market + Finnish language — good match)`;
          }
        } else {
          langNote = ` (doaj_articles requires "en")`;
        }

        // DATASET-SPECIFIC: for job_ads, ALL params are BLOCKERS (Claude must ask every one)
        if (ds === "job_ads") {
          blockers.push(`CONFIRM:SEARCH TERMS: "${params.search_text || "(none)"}"${searchTermNote}. Options: are these good? Add/remove any? Tip: ~20 domain terms, no generic words.`);
          blockers.push(`CONFIRM:LANGUAGE: "${params.language}"${langNote}. Options: which language?`);
          if (!params.country && !params.city) {
            blockers.push("CONFIRM:LOCATION: not set. Options: which country? Or a specific city? (Helsinki, Tampere, Turku, etc.)");
          } else {
            blockers.push(`CONFIRM:LOCATION: ${params.country ? `country="${params.country}"` : `city="${params.city}"`}. Options: is this correct? Different country or city?`);
          }
          blockers.push(`CONFIRM:YEAR: ${params.search_year || "not set (= all available data)"}. Options: all years or a specific year? (2025, 2026)`);
          blockers.push(`CONFIRM:SIZE: ${previewSize}. Options: 50=quick overview, 100=solid, 200=deep analysis, 500=comprehensive`);

        } else if (ds === "doaj_articles") {
          // doaj_articles: search_year REQUIRED, language must be "en"
          blockers.push(`CONFIRM:SEARCH TERMS: "${params.search_text || "(none)"}"${searchTermNote}. Options: are these good?`);
          blockers.push(`CONFIRM:LANGUAGE: requires "en" for doaj_articles.${params.language !== "en" ? ` Currently "${params.language}" — needs to be "en".` : " Already set to en."}`);
          if (!params.search_year) {
            blockers.push("CONFIRM:YEAR: not set. doaj_articles REQUIRES search_year. Options: which year? (e.g. 2025, 2026)");
          } else {
            blockers.push(`CONFIRM:YEAR: ${params.search_year}. Options: is this the right year for research articles?`);
          }
          if (params.country) blockers.push(`CONFIRM:COUNTRY: "${params.country}" — optional for research. Options: keep it or remove?`);
          blockers.push(`CONFIRM:SIZE: ${previewSize}. Options: 50=quick, 100=solid, 200=deep, 500=comprehensive`);

        } else if (ds === "curriculum") {
          blockers.push(`CONFIRM:SEARCH TERMS: "${params.search_text || "(none)"}"${searchTermNote}. Options: are these good?`);
          blockers.push(`CONFIRM:COUNTRY: "${params.country || "not set"}". Usually "fi" for Finnish curricula. Options: which country?`);
          blockers.push(`CONFIRM:LANGUAGE: "${params.language}". Usually "fi" for Finnish curricula. Options: correct?`);
          blockers.push(`CONFIRM:SIZE: ${previewSize}. Options: 50=quick, 100=solid, 200=deep, 500=comprehensive`);

        } else if (ds === "news") {
          blockers.push(`CONFIRM:SEARCH TERMS: "${params.search_text || "(none)"}"${searchTermNote}. Options: are these good?`);
          blockers.push(`CONFIRM:LANGUAGE: "${params.language}"${langNote}. Options: correct?`);
          if (!params.search_year) {
            blockers.push("CONFIRM:YEAR: not set. news REQUIRES search_year. Options: which year? (e.g. 2025, 2026)");
          } else {
            blockers.push(`CONFIRM:YEAR: ${params.search_year}. Options: is this the right year for news?`);
          }
          blockers.push(`CONFIRM:SIZE: ${previewSize}. Options: 50=quick, 100=solid, 200=deep, 500=comprehensive`);

        } else if (ds === "investment_data") {
          blockers.push(`CONFIRM:SEARCH TERMS: "${params.search_text || "(none)"}"${searchTermNote}. Options: are these good?`);
          blockers.push(`CONFIRM:LANGUAGE: "${params.language}"${langNote}. Options: correct?`);
          if (!params.search_year) {
            blockers.push("CONFIRM:YEAR: not set. investment_data REQUIRES search_year. Options: which year?");
          } else {
            blockers.push(`CONFIRM:YEAR: ${params.search_year}. Options: correct year for investment data?`);
          }
          blockers.push(`CONFIRM:SIZE: ${previewSize}. Options: 50=quick, 100=solid, 200=deep, 500=comprehensive`);

        } else if (ds === "theseus") {
          blockers.push(`CONFIRM:SEARCH TERMS: "${params.search_text || "(none)"}"${searchTermNote}. Options: are these good?`);
          blockers.push(`CONFIRM:LANGUAGE: "${params.language}"${langNote}. Options: correct?`);
          blockers.push(`CONFIRM:AFFILIATION: "${params.affiliation || "not set"}". Options: filter by university/institution?`);
          blockers.push(`CONFIRM:SIZE: ${previewSize}. Options: 50=quick, 100=solid, 200=deep, 500=comprehensive`);

        } else {
          // generic fallback — still blockers
          blockers.push(`CONFIRM:SEARCH TERMS: "${params.search_text || "(none)"}"${searchTermNote}. Options: are these good?`);
          blockers.push(`CONFIRM:LANGUAGE: "${params.language}"${langNote}. Options: correct?`);
          if (params.country || params.city) {
            blockers.push(`CONFIRM:LOCATION: ${params.country ? `country="${params.country}"` : `city="${params.city}"`}. Options: correct?`);
          }
          if (params.search_year) {
            blockers.push(`CONFIRM:YEAR: ${params.search_year}. Options: correct?`);
          }
          blockers.push(`CONFIRM:SIZE: ${previewSize}. Options: 50=quick, 100=solid, 200=deep, 500=comprehensive`);
        }

        // Check for language-keyword mismatch
        const mismatch = detectLanguageMismatch(params.language, params.search_text || "");

        // Recalculate hash with the capped size
        const cappedGateParams: Record<string, unknown> = { ...gateParams, size: previewSize };
        const cappedHash = computePreviewHash(cappedGateParams);

        // If there's a language mismatch, BLOCK the build — return error, no hash
        if (mismatch) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ status: "blocked", reason: "language_mismatch", detail: mismatch })
            }]
          };
        }

        // Simple preview — not a Q&A, just a confirmation + hash
        const allIssues = [...blockers, ...questions];
        // Register the hash with a timestamp for time-lock enforcement
        registerPreviewHash(cappedHash);

        // Pure JSON preview response
        const previewResponse: Record<string, unknown> = {
          status: "preview",
          parameters: cleanPreview,
          preview_hash: cappedHash,
          confirmations: allIssues.map(q => q.replace(/^CONFIRM:/, "").trim()),
        };

        return { content: [{ type: "text", text: JSON.stringify(previewResponse) }] };
      }

      // BKG is read-only — no time lock needed (prevents Claude.ai tool-use limit exhaustion)
      // The two-call gate (preview → confirm) is sufficient friction.
      previewTimestamps.delete(params.preview_hash); // one-time use
      const bkgPayload: Record<string, unknown> = {
        dataset: params.dataset,
        language: params.language,
        ontology: params.ontology,
        search_text: params.search_text || "",
        size: Math.min(Number(params.size) || 50, 1000),
        output: "json",
      };
      // Only include date filters when explicitly provided — sending 0 breaks news/doaj/investment datasets
      if (params.search_year !== undefined && params.search_year !== null) {
        bkgPayload.search_year = Number(params.search_year);
      }
      if (params.search_month !== undefined && params.search_month !== null && Number(params.search_month) > 0) {
        bkgPayload.search_month = Number(params.search_month);
      }
      if (params.search_day !== undefined && params.search_day !== null && Number(params.search_day) > 0) {
        bkgPayload.search_day = Number(params.search_day);
      }
      if (params.legend) bkgPayload.legend = params.legend;
      if (params.startDate) bkgPayload.startDate = params.startDate;
      if (params.endDate) bkgPayload.endDate = params.endDate;
      // ── FIX: city + curriculum dataset returns empty ──
      // Workaround: auto-widen to country=fi when curriculum + city
      let curriculumCityWarning = "";
      if (params.dataset === "curriculum" && params.city && !params.country) {
        bkgPayload.country = "fi";
        // Don't set city — it breaks curriculum
        curriculumCityWarning = `⚠️ City-level filtering ("${params.city}") doesn't work with the curriculum dataset — widened to country=fi (all Finnish education). The results include all Finnish institutions, not just ${params.city}.`;
      } else {
        if (params.country) bkgPayload.country = params.country;
        if (params.city) bkgPayload.city = params.city;
      }
      if (params.affiliation) bkgPayload.affiliation = params.affiliation;
      if (params.word_type) bkgPayload.word_type = params.word_type;
      if (params.weighted_search_output !== undefined) bkgPayload.weighted_search_output = params.weighted_search_output;
      if (params.additional_data !== undefined) bkgPayload.additional_data = params.additional_data;
      if (params.noise_list) bkgPayload.noise_list = params.noise_list;
      if (params.use_stored_noise !== undefined) bkgPayload.use_stored_noise = params.use_stored_noise;

      const response = await headaiPost<AsyncJobResponse>(apiKey,"BuildKnowledgeGraph", bkgPayload);

      // If async, poll until ready
      let resultData: unknown = response;
      if (response.status && (response.status.includes("work in progress") || response.status.includes("is in queue") || response.status.includes("in calculation") || response.status === "ready")) {
        resultData = await pollUntilReady(apiKey, response);
      }

      // Extract graph URL from the result
      const resultObj = resultData as Record<string, unknown>;
      let graphUrl = (resultObj.location || resultObj.url || "") as string;

      // ── FIX: graph_url sometimes returns empty after BKG ──
      // Workaround: auto-fetch via list_token_data to find the actual URL
      if (!graphUrl || graphUrl === "") {
        try {
          const tokenDataResp = await axios.get(`${API_BASE_URL}/Utils`, {
            params: { action: "get_token_data", token: apiKey, endpoint: "BuildKnowledgeGraph" },
            headers: getAuthHeaders(apiKey),
            timeout: 15000,
          });
          // Response is an array of URLs or objects — grab the most recent one
          const tokenData = tokenDataResp.data;
          if (Array.isArray(tokenData) && tokenData.length > 0) {
            const latest = tokenData[tokenData.length - 1];
            graphUrl = typeof latest === "string" ? latest : (latest.url || latest.location || "");
          } else if (typeof tokenData === "object" && tokenData.data) {
            const arr = Array.isArray(tokenData.data) ? tokenData.data : [];
            if (arr.length > 0) {
              const latest = arr[arr.length - 1];
              graphUrl = typeof latest === "string" ? latest : (latest.url || latest.location || "");
            }
          }
        } catch (_listErr) {
          // list_token_data failed — continue without URL
        }
      }

      const visualizerUrl = graphUrl
        ? `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(graphUrl)}`
        : "";

      // Extract graph data — try inline first, then fetch from graph URL if needed
      let inner = (resultObj.data && typeof resultObj.data === "object")
        ? resultObj.data as Record<string, unknown>
        : resultObj;

      let nodes = Array.isArray(inner.nodes) ? inner.nodes as Array<Record<string, unknown>> : [];

      // Async polling results often don't include inline graph data — fetch it from the URL
      if (nodes.length === 0 && graphUrl) {
        try {
          const graphFetch = await axios.get(graphUrl, { timeout: 60000 });
          const gd = graphFetch.data as Record<string, unknown>;
          if (gd && typeof gd === "object") {
            inner = (gd.data && typeof gd.data === "object")
              ? gd.data as Record<string, unknown>
              : gd;
            nodes = Array.isArray(inner.nodes) ? inner.nodes as Array<Record<string, unknown>> : [];
          }
        } catch (_fetchErr) {
          // Graph fetch failed — continue with whatever we have
        }
      }

      const edges = Array.isArray(inner.edges) ? inner.edges as Array<Record<string, unknown>> : [];
      const tags = Array.isArray(inner.tags) ? inner.tags.filter((t: unknown) => typeof t === "string") as string[] : [];
      const sources = Array.isArray(inner.sources) ? inner.sources as Array<Record<string, unknown>> : [];

      const companies = tags.filter(t => t.startsWith("company:")).map(t => t.replace("company:", ""));
      const cities = tags.filter(t => t.startsWith("city:")).map(t => t.replace("city:", ""));

      const topNodes = [...nodes]
        .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0) || Number(b.value ?? 0) - Number(a.value ?? 0))
        .slice(0, 15)
        .map(n => ({ label: n.label, weight: n.weight, group: n.group }));

      const responseJson: Record<string, unknown> = {
        status: "ready",
        graph_url: graphUrl,
        visualizer_url: visualizerUrl,
        title: inner.title || params.legend,
        node_count: nodes.length,
        edge_count: edges.length,
        source_count: sources.length,
        top_skills: topNodes,
        companies: companies.slice(0, 30),
        cities: cities,
        sample_sources: sources.slice(0, 5).map(s => ({ title: s.title, url: s.url })),
      };

      // Include curriculum city fallback warning if triggered
      if (curriculumCityWarning) {
        responseJson.warning = curriculumCityWarning;
      }

      // Warn if graph_url is still empty after list_token_data fallback
      if (!graphUrl) {
        responseJson.warning = (responseJson.warning || "") + " ⚠️ graph_url is empty — the graph may still be processing. Use headai_list_token_data(endpoint: 'BuildKnowledgeGraph') to find it later.";
      }

      return { content: [{ type: "text", text: JSON.stringify(responseJson) }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Visual Report ──────────────────────────────────────────────────────
// Generates an interactive HTML dashboard from a knowledge graph

// Finnish city coordinates for map visualization
const FINNISH_CITY_COORDS: Record<string, [number, number]> = {
  helsinki: [60.1699, 24.9384], espoo: [60.2055, 24.6559], tampere: [61.4978, 23.7610],
  vantaa: [60.2934, 25.0378], oulu: [65.0121, 25.4651], turku: [60.4518, 22.2666],
  jyväskylä: [62.2426, 25.7473], lahti: [60.9827, 25.6612], kuopio: [62.8924, 27.6770],
  pori: [61.4851, 21.7974], kouvola: [60.8681, 26.7043], joensuu: [62.6010, 29.7636],
  lappeenranta: [61.0587, 28.1871], hämeenlinna: [60.9929, 24.4604], vaasa: [63.0960, 21.6158],
  seinäjoki: [62.7903, 22.8403], rovaniemi: [66.5039, 25.7294], mikkeli: [61.6886, 27.2722],
  kotka: [60.4664, 26.9458], salo: [60.3836, 23.1333], porvoo: [60.3929, 25.6644],
  kokkola: [63.8384, 23.1308], kajaani: [64.2267, 27.7277], rauma: [61.1286, 21.5108],
  savonlinna: [61.8688, 28.8797], nokia: [61.4777, 23.5084], ylöjärvi: [61.5524, 23.5953],
  kaarina: [60.4068, 22.3713], kangasala: [61.4641, 24.0762], riihimäki: [60.7387, 24.7717],
  imatra: [61.1712, 28.7527], lempäälä: [61.3133, 23.7517], kerava: [60.4034, 25.1042],
  iisalmi: [63.5578, 27.1909], hollola: [60.9883, 25.5178], forssa: [60.8144, 23.6210],
  valkeakoski: [61.2652, 24.0313], raahe: [64.6822, 24.4794], raisio: [60.4860, 22.1690],
  lohja: [60.2487, 24.0657], hyvinkää: [60.6310, 24.8610], järvenpää: [60.4740, 25.0890],
  kirkkonummi: [60.1233, 24.4374], nurmijärvi: [60.4649, 24.8092], sipoo: [60.3771, 25.2628],
  tuusula: [60.4036, 25.0293],
  // Non-Finnish cities that may appear
  stockholm: [59.3293, 18.0686], london: [51.5074, -0.1278], berlin: [52.5200, 13.4050],
  tallinn: [59.4370, 24.7536], new_york: [40.7128, -74.0060], amsterdam: [52.3676, 4.9041],
};

function generateVisualReportHTML(
  graphData: Record<string, unknown>,
  title: string,
  reportType: string
): string {
  const inner = (graphData.data && typeof graphData.data === "object")
    ? graphData.data as Record<string, unknown>
    : graphData;

  // Extract nodes
  const nodes = (Array.isArray(inner.nodes) ? inner.nodes : []) as Array<Record<string, unknown>>;
  const edges = (Array.isArray(inner.edges) ? inner.edges : []) as Array<Record<string, unknown>>;
  const tags = (Array.isArray(inner.tags) ? inner.tags : []).filter((t: unknown) => typeof t === "string") as string[];
  const sources = (Array.isArray(inner.sources) ? inner.sources : []) as Array<Record<string, unknown>>;

  // Process companies from tags
  const companies: Record<string, number> = {};
  const cities: Record<string, number> = {};
  for (const tag of tags) {
    if (tag.startsWith("company:")) {
      const name = tag.replace("company:", "").trim();
      companies[name] = (companies[name] || 0) + 1;
    }
    if (tag.startsWith("city:")) {
      const name = tag.replace("city:", "").trim();
      cities[name] = (cities[name] || 0) + 1;
    }
  }

  // Sort companies and cities by count
  const topCompanies = Object.entries(companies).sort((a, b) => b[1] - a[1]).slice(0, 25);
  const topCities = Object.entries(cities).sort((a, b) => b[1] - a[1]);

  // Sort nodes by weight then value — domain-specific (weight >= 3)
  const domainNodes = nodes
    .filter(n => Number(n.weight ?? 0) >= 3)
    .sort((a, b) => {
      const wd = Number(b.weight ?? 0) - Number(a.weight ?? 0);
      return wd !== 0 ? wd : Number(b.value ?? 0) - Number(a.value ?? 0);
    })
    .slice(0, 30);

  // All nodes sorted for skills overview
  const allNodesSorted = [...nodes].sort((a, b) => {
    const wd = Number(b.weight ?? 0) - Number(a.weight ?? 0);
    return wd !== 0 ? wd : Number(b.value ?? 0) - Number(a.value ?? 0);
  });

  // Group nodes by group field
  const nodeGroups: Record<string, Array<Record<string, unknown>>> = {};
  for (const n of nodes) {
    const g = String(n.group ?? "other");
    if (!nodeGroups[g]) nodeGroups[g] = [];
    nodeGroups[g].push(n);
  }

  // Build city map data
  const cityMapData = topCities.map(([name, count]) => {
    const key = name.toLowerCase().replace(/[^a-zäöåü]/g, "");
    const coords = FINNISH_CITY_COORDS[key];
    return { name, count, lat: coords?.[0] ?? null, lng: coords?.[1] ?? null };
  }).filter(c => c.lat !== null);

  // Legends info
  const legends = inner.legends as Record<string, unknown> | undefined;
  const legendText = legends ? Object.values(legends).join(" · ") : title;

  // Stats
  const totalNodes = nodes.length;
  const totalEdges = edges.length;
  const totalCompanies = Object.keys(companies).length;
  const totalCities = Object.keys(cities).length;
  const totalSources = sources.length;

  // Color palette
  const colors = [
    "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
    "#f43f5e", "#f97316", "#eab308", "#84cc16", "#22c55e",
    "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1"
  ];
  const groupColors: Record<string, string> = {};
  const groupKeys = Object.keys(nodeGroups);
  groupKeys.forEach((g, i) => { groupColors[g] = colors[i % colors.length]; });

  // Generate HTML
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Headai Visual Report</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
  :root {
    --bg: #0f172a; --surface: #1e293b; --surface2: #334155;
    --text: #f1f5f9; --text-muted: #94a3b8; --accent: #6366f1;
    --accent2: #a855f7; --green: #22c55e; --orange: #f97316;
    --border: #475569; --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6;
  }
  .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
  .header {
    background: linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
    padding: 40px; border-radius: var(--radius); margin-bottom: 24px;
    position: relative; overflow: hidden;
  }
  .header::after {
    content: ''; position: absolute; top: 0; right: 0; bottom: 0; left: 0;
    background: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
  }
  .header h1 { font-size: 28px; font-weight: 700; position: relative; z-index: 1; }
  .header p { opacity: 0.9; margin-top: 8px; font-size: 16px; position: relative; z-index: 1; }
  .stats-row {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 16px; margin-bottom: 24px;
  }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px; text-align: center;
  }
  .stat-card .number { font-size: 32px; font-weight: 700; color: var(--accent); }
  .stat-card .label { font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  .grid-full { grid-column: 1 / -1; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 24px; overflow: hidden;
  }
  .card h2 {
    font-size: 18px; font-weight: 600; margin-bottom: 16px;
    display: flex; align-items: center; gap: 8px;
  }
  .bar-chart .bar-row { display: flex; align-items: center; margin-bottom: 8px; gap: 12px; }
  .bar-chart .bar-label {
    min-width: 160px; max-width: 200px; font-size: 13px; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right;
  }
  .bar-chart .bar-track { flex: 1; height: 28px; background: var(--surface2); border-radius: 6px; overflow: hidden; position: relative; }
  .bar-chart .bar-fill {
    height: 100%; border-radius: 6px; transition: width 0.8s ease;
    display: flex; align-items: center; padding-left: 8px; font-size: 12px; font-weight: 600;
    min-width: 30px;
  }
  .bar-chart .bar-value { font-size: 13px; color: var(--text-muted); min-width: 36px; }
  .skill-pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .skill-pill {
    padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 500;
    border: 1px solid var(--border); cursor: default; transition: transform 0.2s;
  }
  .skill-pill:hover { transform: scale(1.05); }
  .skill-pill.w5 { background: rgba(99,102,241,0.3); border-color: var(--accent); color: #a5b4fc; }
  .skill-pill.w4 { background: rgba(168,85,247,0.2); border-color: var(--accent2); color: #c4b5fd; }
  .skill-pill.w3 { background: rgba(34,197,94,0.15); border-color: var(--green); color: #86efac; }
  .skill-pill.w2 { background: var(--surface2); color: var(--text-muted); }
  .source-list { list-style: none; }
  .source-list li {
    padding: 10px 0; border-bottom: 1px solid var(--surface2);
    font-size: 14px;
  }
  .source-list li:last-child { border-bottom: none; }
  .source-list a { color: #93c5fd; text-decoration: none; }
  .source-list a:hover { text-decoration: underline; }
  .source-list .source-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  #map { height: 400px; border-radius: 8px; }
  .tab-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab-btn {
    padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text-muted); cursor: pointer;
    font-size: 13px; font-weight: 500; transition: all 0.2s;
  }
  .tab-btn:hover { border-color: var(--accent); color: var(--text); }
  .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
  .group-section { margin-bottom: 16px; }
  .group-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; padding-left: 4px; }
  .footer {
    text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;
    border-top: 1px solid var(--border); margin-top: 24px;
  }
  .footer a { color: var(--accent); text-decoration: none; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>${title}</h1>
    <p>${legendText} · powered by Headai Core Engine</p>
  </div>

  <div class="stats-row">
    <div class="stat-card"><div class="number">${totalNodes}</div><div class="label">Skills / Concepts</div></div>
    <div class="stat-card"><div class="number">${totalEdges}</div><div class="label">Connections</div></div>
    <div class="stat-card"><div class="number">${totalCompanies}</div><div class="label">Companies</div></div>
    <div class="stat-card"><div class="number">${totalCities}</div><div class="label">Locations</div></div>
    <div class="stat-card"><div class="number">${totalSources}</div><div class="label">Source Documents</div></div>
  </div>

  <div class="grid">

    <!-- Skills Overview -->
    <div class="card grid-full">
      <h2>🧠 Skills &amp; Competencies</h2>
      <div class="tab-bar" id="skillTabs">
        <button class="tab-btn active" data-view="all">All Top Skills</button>
        ${groupKeys.map(g => `<button class="tab-btn" data-view="group-${g}">${g} (${nodeGroups[g].length})</button>`).join("\n        ")}
      </div>
      <div id="skillView-all" class="skill-view">
        <div class="skill-pills">
          ${allNodesSorted.slice(0, 50).map(n => {
            const w = Number(n.weight ?? 1);
            const wClass = w >= 5 ? "w5" : w >= 4 ? "w4" : w >= 3 ? "w3" : "w2";
            return `<span class="skill-pill ${wClass}" title="weight: ${w}, connections: ${n.degree ?? n.value ?? '?'}">${n.label}</span>`;
          }).join("\n          ")}
        </div>
      </div>
      ${groupKeys.map(g => `
      <div id="skillView-group-${g}" class="skill-view hidden">
        <div class="skill-pills">
          ${(nodeGroups[g] || []).sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0)).slice(0, 30).map(n => {
            const w = Number(n.weight ?? 1);
            const wClass = w >= 5 ? "w5" : w >= 4 ? "w4" : w >= 3 ? "w3" : "w2";
            return `<span class="skill-pill ${wClass}" title="weight: ${w}, connections: ${n.degree ?? n.value ?? '?'}">${n.label}</span>`;
          }).join("\n          ")}
        </div>
      </div>`).join("")}
    </div>

    <!-- Top Companies -->
    <div class="card">
      <h2>🏢 Top Hiring Companies</h2>
      <div class="bar-chart">
        ${topCompanies.length > 0
          ? topCompanies.map(([name, count], i) => {
              const maxCount = topCompanies[0][1];
              const pct = Math.max(8, (count / maxCount) * 100);
              const color = colors[i % colors.length];
              return `<div class="bar-row">
          <div class="bar-label" title="${name}">${name}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}">${count}</div></div>
        </div>`;
            }).join("\n        ")
          : '<p style="color:var(--text-muted)">No company data in this graph</p>'}
      </div>
    </div>

    <!-- City Map -->
    <div class="card">
      <h2>📍 Hiring Locations</h2>
      ${cityMapData.length > 0
        ? `<div id="map"></div>
      <div style="margin-top:12px;font-size:13px;color:var(--text-muted)">
        ${topCities.map(([name, count]) => `${name}: ${count}`).join(" · ")}
      </div>`
        : `<div class="bar-chart">
        ${topCities.map(([name, count], i) => {
          const maxCount = topCities[0]?.[1] ?? 1;
          const pct = Math.max(8, (count / maxCount) * 100);
          return `<div class="bar-row">
          <div class="bar-label">${name}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${colors[i % colors.length]}">${count}</div></div>
        </div>`;
        }).join("\n        ")}
        ${topCities.length === 0 ? '<p style="color:var(--text-muted)">No location data in this graph</p>' : ''}
      </div>`}
    </div>

    <!-- Domain-Specific Skills Bar Chart -->
    <div class="card grid-full">
      <h2>⚡ Domain-Specific Skills (weight ≥ 3)</h2>
      <div class="bar-chart">
        ${domainNodes.map((n, i) => {
          const w = Number(n.weight ?? 1);
          const v = Number(n.degree ?? n.value ?? 0);
          const maxV = Math.max(...domainNodes.map(x => Number(x.degree ?? x.value ?? 0)), 1);
          const pct = Math.max(8, (v / maxV) * 100);
          const gColor = groupColors[String(n.group ?? "other")] || colors[i % colors.length];
          return `<div class="bar-row">
          <div class="bar-label" title="${n.label} (group: ${n.group})">${n.label}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${gColor}">w${w}</div></div>
          <div class="bar-value">${v}</div>
        </div>`;
        }).join("\n        ")}
      </div>
    </div>

    <!-- Source Documents -->
    ${sources.length > 0 ? `
    <div class="card grid-full">
      <h2>📄 Source Documents (${totalSources})</h2>
      <ul class="source-list">
        ${sources.slice(0, 15).map(s => {
          const srcTitle = String(s.title || s.name || "Untitled");
          const srcUrl = String(s.url || s.link || "#");
          const srcDate = s.date ? ` · ${s.date}` : "";
          const srcCompany = s.company ? ` · ${s.company}` : "";
          return `<li>
          <a href="${srcUrl}" target="_blank" rel="noopener">${srcTitle}</a>
          <div class="source-meta">${srcUrl.replace(/https?:\/\//, "").split("/")[0]}${srcCompany}${srcDate}</div>
        </li>`;
        }).join("\n        ")}
        ${sources.length > 15 ? `<li style="color:var(--text-muted)">... and ${sources.length - 15} more source documents</li>` : ""}
      </ul>
    </div>` : ""}

  </div>

  <div class="footer">
    Generated by <a href="https://headai.com">Headai</a> Core Engine · ${new Date().toISOString().split("T")[0]}
  </div>
</div>

<script>
// Tab switching for skill groups
document.getElementById('skillTabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.skill-view').forEach(v => v.classList.add('hidden'));
  const viewId = 'skillView-' + btn.dataset.view;
  document.getElementById(viewId)?.classList.remove('hidden');
});

// Leaflet map initialization
${cityMapData.length > 0 ? `
(function() {
  const cityData = ${JSON.stringify(cityMapData)};
  if (cityData.length === 0) return;

  const map = L.map('map', { scrollWheelZoom: false }).setView([${
    cityMapData.length > 0 ? `${cityMapData[0].lat}, ${cityMapData[0].lng}` : "62.0, 25.0"
  }], 6);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18
  }).addTo(map);

  const maxCount = Math.max(...cityData.map(c => c.count));
  cityData.forEach(city => {
    if (!city.lat || !city.lng) return;
    const radius = Math.max(8, Math.min(35, (city.count / maxCount) * 35));
    L.circleMarker([city.lat, city.lng], {
      radius: radius,
      fillColor: '#6366f1',
      color: '#a5b4fc',
      weight: 2,
      opacity: 0.9,
      fillOpacity: 0.6
    }).addTo(map).bindPopup(
      '<strong>' + city.name + '</strong><br>' + city.count + ' mentions'
    );
  });

  // Fit bounds
  if (cityData.length > 1) {
    const bounds = cityData.filter(c => c.lat && c.lng).map(c => [c.lat, c.lng]);
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
  }
})();` : "// No city map data"}
<\/script>
</body>
</html>`;
}

server.registerTool(
  "headai_visual_report",
  {
    title: "Extract Graph Data for Visual Report",
    description: `Extract structured visualization data from a Headai knowledge graph. Returns companies (with counts), cities (with coordinates), skills (weights, degrees, groups), source documents (URLs), and graph statistics. Data comes from the actual graph JSON. Use the returned data to create an interactive HTML dashboard (dark theme, Leaflet map, charts). Free and instant — no API call needed.`,
    inputSchema: {
      graph_url: z.string().describe("The graph JSON URL from a previous build (e.g., from headai_build_knowledge_graph result)"),
      title: z.string().optional().describe("Report title (defaults to graph legend)"),
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
      // Fetch the graph JSON
      const graphResponse = await axios.get(params.graph_url, { timeout: 30000 });
      const graphData = graphResponse.data as Record<string, unknown>;

      const inner = (graphData.data && typeof graphData.data === "object")
        ? graphData.data as Record<string, unknown>
        : graphData;

      // Extract nodes
      const nodes = (Array.isArray(inner.nodes) ? inner.nodes : []) as Array<Record<string, unknown>>;
      const edges = (Array.isArray(inner.edges) ? inner.edges : []) as Array<Record<string, unknown>>;
      const tags = (Array.isArray(inner.tags) ? inner.tags : []).filter((t: unknown) => typeof t === "string") as string[];
      const sources = (Array.isArray(inner.sources) ? inner.sources : []) as Array<Record<string, unknown>>;
      const legends = inner.legends as Record<string, unknown> | undefined;

      // Process companies
      const companyMap: Record<string, number> = {};
      const cityMap: Record<string, number> = {};
      for (const tag of tags) {
        if (tag.startsWith("company:")) {
          const name = tag.replace("company:", "").trim();
          companyMap[name] = (companyMap[name] || 0) + 1;
        }
        if (tag.startsWith("city:")) {
          const name = tag.replace("city:", "").trim();
          cityMap[name] = (cityMap[name] || 0) + 1;
        }
      }
      const topCompanies = Object.entries(companyMap).sort((a, b) => b[1] - a[1]).slice(0, 25);
      const topCities = Object.entries(cityMap).sort((a, b) => b[1] - a[1]);

      // Add coordinates to cities
      const citiesWithCoords = topCities.map(([name, count]) => {
        const key = name.toLowerCase().replace(/[^a-zäöåü]/g, "");
        const coords = FINNISH_CITY_COORDS[key];
        return { name, count, lat: coords?.[0] ?? null, lng: coords?.[1] ?? null };
      });

      // Process skills
      const topSkills = [...nodes]
        .sort((a, b) => {
          const wd = Number(b.weight ?? 0) - Number(a.weight ?? 0);
          return wd !== 0 ? wd : Number(b.value ?? 0) - Number(a.value ?? 0);
        })
        .slice(0, 50)
        .map(n => ({
          name: String(n.label || n.id || "?"),
          weight: Number(n.weight ?? 1),
          degree: Number(n.degree ?? n.value ?? 0),
          group: String(n.group ?? "other"),
        }));

      // Groups
      const groups: Record<string, number> = {};
      for (const n of nodes) {
        const g = String(n.group ?? "other");
        groups[g] = (groups[g] || 0) + 1;
      }

      // Top edges
      const topEdges = [...edges]
        .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
        .slice(0, 10)
        .map(e => ({
          from: String(e.title || `${e.from} ↔ ${e.to}`),
          value: Number(e.value ?? 0),
        }));

      // Source documents
      const topSources = sources.slice(0, 15).map(s => ({
        title: String(s.title || s.name || "Untitled"),
        url: String(s.url || s.link || ""),
        company: s.company ? String(s.company) : undefined,
        date: s.date ? String(s.date) : undefined,
      }));

      // Title
      const reportTitle = params.title
        || (legends ? String(Object.values(legends)[0] || "Headai Report") : "Headai Report");

      // Build structured response
      const report = {
        title: reportTitle,
        graph_url: params.graph_url,
        visualizer_url: `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(params.graph_url)}`,
        stats: {
          total_nodes: nodes.length,
          total_edges: edges.length,
          total_companies: Object.keys(companyMap).length,
          total_cities: Object.keys(cityMap).length,
          total_sources: sources.length,
        },
        companies: topCompanies.map(([name, count]) => ({ name, count })),
        cities: citiesWithCoords,
        skills: topSkills,
        groups,
        strongest_connections: topEdges,
        sources: topSources,
      };

      return {
        content: [{
          type: "text",
          text: `GRAPH DATA EXTRACTED — use this to create an interactive HTML artifact.

${JSON.stringify(report, null, 2)}

INSTRUCTIONS FOR ARTIFACT:
Create an HTML artifact (dark theme) with these sections using the REAL DATA above:
1. Header with title "${reportTitle}"
2. Stats row (${nodes.length} skills, ${edges.length} connections, ${Object.keys(companyMap).length} companies, ${Object.keys(cityMap).length} locations, ${sources.length} sources)
3. Company bar chart — use the companies array above (these are REAL company names from job ads)
4. City MAP — use Leaflet.js from unpkg CDN with CartoDB dark tiles. City coordinates are included above. Circle markers proportional to count.
5. Skills pills — color by weight (w5=blue glow, w4=purple, w3=green, w2=muted). Add tabs to filter by group.
6. Domain skills bar chart — weight≥3 skills sorted by degree, colored by group
7. Source documents — real URLs from job postings, make them clickable

All data above is extracted from the actual graph. Use only this data for the artifact.`
        }]
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed to extract graph data: ${handleApiError(error)}` }], isError: true };
    }
  }
);

// ── Tool: Scorecard ────────────────────────────────────────────────────────

server.registerTool(
  "headai_scorecard",
  {
    title: "Compare Two Knowledge Graphs (Scorecard)",
    description: `Compare two knowledge graphs or texts to produce a skill gap analysis with match score.

Input modes: Graph vs Graph (map_url_1 + map_url_2), Text vs Text (text_1 + text_2), Mixed (one URL + one text), SDG (item + scorecard preset).

Output: 3 groups (common skills, unique to first, unique to second) plus match score.

Comparison reports available after: 309=gap analysis, 308=quick wins, 305=unexpected overlaps, 310=surprise bridges.`,
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
      readOnlyHint: true,
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

      // Text-based comparisons take 5+ minutes (internal TextToGraph) — use longer timeout
      const hasText = !!(params.text_1 || params.text_2);
      const scTimeout = hasText ? 400000 : 120000;

      const response = await axios.post(`${API_BASE_URL}/Scorecard`, payload, {
        headers: getAuthHeaders(apiKey),
        timeout: scTimeout,
      });
      let rawResult: any = response.data;

      if (rawResult.status && typeof rawResult.status === "string" &&
          (rawResult.status.includes("work in progress") || rawResult.status.includes("is in queue") || rawResult.status.includes("in calculation") || rawResult.status === "ready")) {
        rawResult = await pollUntilReady(apiKey, rawResult);
      }

      // ── FIX: Scorecard not in list_token_data → process inline ──
      // Parse the result and produce structured output that can be chained to reports
      const scoreData = rawResult.data && rawResult.data.nodes ? rawResult.data : rawResult;
      const nodes = scoreData.nodes || [];
      const legends = scoreData.legends || {};

      if (nodes.length === 0) {
        return { content: [{ type: "text", text: "Scorecard returned no results. The API may still be processing — try again in a minute.\n\nRaw response:\n" + JSON.stringify(rawResult, null, 2).substring(0, 2000) }] };
      }

      // ── Format Scorecard results ──
      const legend1 = legends["2"] || params.legend_1 || "Input 1";
      const legend2 = legends["3"] || params.legend_2 || "Input 2";

      // Group nodes: 1=shared, 2=unique to first, 3=unique to second (gaps)
      const shared = nodes.filter((n: any) => String(n.group) === "1");
      const unique1 = nodes.filter((n: any) => String(n.group) === "2");
      const gaps = nodes.filter((n: any) => String(n.group) === "3");
      const matchPct = (shared.length + gaps.length) > 0
        ? Math.round((shared.length / (shared.length + gaps.length)) * 100)
        : 0;

      const formatNodes = (arr: any[], limit: number) =>
        arr.sort((a: any, b: any) => (b.weight || 0) - (a.weight || 0))
          .slice(0, limit)
          .map((n: any) => `${n.label || n.id} (w:${n.weight || 0})`);

      const output: Record<string, unknown> = {
        match_score: `${matchPct}%`,
        total_concepts: nodes.length,
        shared_count: shared.length,
        gap_count: gaps.length,
        unique_extras_count: unique1.length,
        legend_1: legend1,
        legend_2: legend2,
        shared_skills: formatNodes(shared, 20),
        gaps: formatNodes(gaps, 20),
        your_extras: formatNodes(unique1, 15),
        summary: `${matchPct}% match — ${shared.length} shared skills, ${gaps.length} gaps to fill, ${unique1.length} extra skills beyond requirements.`,
        // ── Persistence workaround: include inline graph data for chaining ──
        // Scorecard results don't appear in list_token_data, so we include
        // the full graph here for use with run_analyst report 309
        _scorecard_graph: scoreData,
        note: "Scorecard results are NOT persisted to a URL. To run analyst reports (e.g. 309), pass the _scorecard_graph data directly.",
      };

      return { content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(output, null, 2)) }] };
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
    description: `Get personalized course or job recommendations based on a skill profile.

Course namespaces: metropolia, Tuni, Aalto University, University of Helsinki, koulutusfi, linkedin_learning, inokufu udemy, inokufu coursera, classcentral, any.
Job namespaces: TMT, Duunitori, MOL, Eures, kuntarekry, valtiolle, any. For jobs, include "jobs" in request array.

Request modes: "match" (best overlap), "zpd" (stretch goals), "demand" (market demand), "jobs" (for job namespaces).

Returns ranked recommendations with match scores, new skills gained, and course/job details.
  - city_limit (string[]): City names for job filtering (e.g. ["helsinki"])`,
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

      // Trim large arrays to keep response compact (avoids content filters on some platforms)
      const trimCompassResult = (obj: unknown): unknown => {
        if (Array.isArray(obj)) {
          return obj.map(trimCompassResult);
        }
        if (obj && typeof obj === "object") {
          const rec = obj as Record<string, unknown>;
          const trimmed: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(rec)) {
            if ((key === "missing_skills" || key === "missing_penalty_score") && Array.isArray(value)) {
              // Drop missing_skills entirely — too large, not useful for recommendations
              continue;
            }
            if (key === "new_skills" && Array.isArray(value)) {
              // Keep only top 15 new skills
              trimmed[key] = (value as string[]).slice(0, 15);
            } else if (key === "description" && typeof value === "string" && (value as string).length > 300) {
              trimmed[key] = (value as string).slice(0, 300) + "...";
            } else {
              trimmed[key] = trimCompassResult(value);
            }
          }
          return trimmed;
        }
        return obj;
      };

      // Also limit to top 10 recommendations per category
      const trimmedResult = trimCompassResult(result) as Record<string, unknown>;
      for (const key of Object.keys(trimmedResult)) {
        if (key.startsWith("recommendations_") && Array.isArray(trimmedResult[key])) {
          trimmedResult[key] = (trimmedResult[key] as unknown[]).slice(0, 10);
        }
      }

      const text = fixVisualizerUrls(truncateIfNeeded(JSON.stringify(trimmedResult, null, 2)));
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
      readOnlyHint: true,
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
      const text = fixVisualizerUrls(truncateIfNeeded(JSON.stringify(result, null, 2)));
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
      readOnlyHint: true,
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
      const text = fixVisualizerUrls(truncateIfNeeded(JSON.stringify(result, null, 2)));
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
      readOnlyHint: true,
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
      const text = fixVisualizerUrls(truncateIfNeeded(JSON.stringify(result, null, 2)));
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
    description: `Analyze trends across 2+ chronological knowledge graph snapshots. Async operation.

Signal groups: 1=Emerging, 2=Constantly Increasing, 3=Increasing last period, 4=Constant, 5=Constant last period, 6=Constantly Decreasing, 7=Decreasing last period, 8=Disappearing.

predict=false (default): map_legends can be free text. predict=true: map_legends must be ascending years.

Trend reports: 401=emerging, 406=fading, 408=disruption zones, 407=sharp drops.
Visualizer: https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=<result_url>`,
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
      const text = fixVisualizerUrls(truncateIfNeeded(JSON.stringify(result, null, 2)));
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
      readOnlyHint: true,
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
    description: `Low-level debug tool for raw graph data access. For structured insights after a build, headai_run_analyst(report: 999) is preferred.

Only use fetch_graph when you need the raw JSON data for a specific reason (e.g., user asks to see raw data, or you need to parse specific node details manually).

Args:
  - url (string, required): Full URL to the graph JSON (typically on megatron.headai.com/analysis/...)

Returns: The full knowledge graph JSON (can be very large).`,
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
      const text = fixVisualizerUrls(truncateIfNeeded(JSON.stringify(response.data, null, 2)));
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
    description: `Low-level debug tool for raw graph data access. For structured insights after a build, headai_run_analyst(report: 999) is preferred.

Only use fetch_and_save when you specifically need to save the raw JSON to disk for later processing (e.g., very large scorecards where you need to parse specific fields). The save_path must be a valid path on the MCP server container (e.g., /tmp/graph.json).

Args:
  - url (string, required): Full URL to the graph JSON
  - save_path (string, required): Local file path on the MCP server to save to (use /tmp/)

Returns: A compact summary (node count, groups, top concepts) + the saved file path.`,
    inputSchema: {
      url: z.string().url().describe("Full URL to the knowledge graph JSON"),
      save_path: z.string().describe("Local file path to save the full JSON to"),
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
    description: `Search for real, current job listings matching skills or keywords. Returns actual job ads with links.

WHEN TO USE: When the user asks "find me jobs", "what jobs are available", "show me job listings for X in Y". This returns ACTUAL job postings with URLs, not just skill analysis. For skill/market analysis without specific listings, use build_knowledge_graph with dataset "job_ads" instead.

EXAMPLE CALLS:
  • "Find software developer jobs in Helsinki" → get_jobs_by_text(search: "software developer", keywords: "python,javascript,react", area: "Helsinki", country: "fi", language: "en")
  • "What project management jobs are in Tampere?" → get_jobs_by_text(search: "project manager", keywords: "agile,scrum,stakeholder management", area: "Tampere", country: "fi", language: "fi")

Each result includes: job title, company, URL to apply, match score, matched skills, and missing skills (gap).

Args:
  - search (string): Job title or role to search (e.g. "software developer", "data analyst")
  - keywords (string): Comma-separated skills to match (e.g. "java,python,mysql"). More keywords = better matching.
  - area (string, required): City or region (e.g. "Helsinki", "Tampere", "Turku")
  - country (string, required): ISO 2-letter code (e.g. "fi")
  - language (string, required): ISO 2-letter code (e.g. "fi", "en")
  - author (string, optional): Filter by source — "mol" or "tmt"
  - limit (number, optional): Max results 10-50 (default 20)
  - remove (string, optional): Exclude keywords (e.g. "intern,junior")`,
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

      // Trim job listing responses — descriptions and missing_skills are huge
      const trimJobResult = (obj: unknown): unknown => {
        if (Array.isArray(obj)) return obj.map(trimJobResult);
        if (obj && typeof obj === "object") {
          const rec = obj as Record<string, unknown>;
          const trimmed: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(rec)) {
            if (key === "missing_skills") continue; // Drop entirely — can be 300+ items
            if (key === "description" && typeof value === "string" && (value as string).length > 400) {
              trimmed[key] = (value as string).slice(0, 400) + "...";
            } else {
              trimmed[key] = trimJobResult(value);
            }
          }
          return trimmed;
        }
        return obj;
      };

      const trimmedResult = trimJobResult(result);
      const text = truncateIfNeeded(JSON.stringify(trimmedResult, null, 2));
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
    description: `Run algorithmic analysis reports on knowledge graphs, scorecards, or signals. Returns raw findings (clusters, scores, lists) to be interpreted into narrative insights.

Term translations: ego1=skill cluster, bridge=cross-field connector, degree=connectivity, weight 5=specialized, hidden strength=undervalued niche, outlier=unexpected finding.

Graph reports: 7=cross-field connectors, 8=undervalued niches, 10=unexpected findings, 21=isolated demand, 999=data insight.
Scorecard reports: 309=gap analysis, 308=quick wins, 305=unexpected overlaps, 310=surprise bridges.
Signal reports: 401=emerging, 406=fading, 408=disruption zones, 407=sharp drops.
Skip reports 13, 14, 15, 200, 203 (slow internal LLM). Other: 1=hubs, 6=pairs, 9=noise, 198=quality score.`,
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
    description: `Low-level debug tool for raw graph data access. For structured insights after a build, headai_run_analyst(report: 999) is preferred.

describe_graph only returns basic metadata (dataset, search params, node count). For actual analysis and insights, always prefer run_analyst.

Only use describe_graph when you need to check what parameters a graph was built with, or to verify metadata without running a full analysis.

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
    description: `Check data availability for a dataset. Only useful when the user specifically asks about data size or availability.

Not needed before building a graph — build_knowledge_graph can be called directly.

Use case: user asks "how much data is there?" or "what's the dataset size?"

EXAMPLE: estimate_size(dataset: "job_ads", search_text: "AI,machine learning", country: "fi", language: "en") → returns count like "3,241 matching records"

Args:
  - dataset (string, required): "job_ads", "doaj_articles", "curriculum", "theseus", "investment_data", "news", "tiedejatutkimus"
  - search_text (string): Keywords to filter (same format as build_knowledge_graph)
  - language (string): Language code (default: "en"). Required for doaj_articles, investment_data, news, tiedejatutkimus.
  - ontology (string): Ontology — "headai", "esco", "lightcast" (default: "headai")
  - search_year (number): Year filter. Required for doaj_articles, investment_data, news, tiedejatutkimus.
  - country (string): Country code filter (e.g., "fi"). Mutually exclusive with city.
  - city (string): City name filter (e.g., "Helsinki"). Mutually exclusive with country.`,
    inputSchema: {
      dataset: z.string().describe("Dataset: job_ads, doaj_articles, curriculum, theseus, investment_data, news, tiedejatutkimus"),
      search_text: z.string().optional().describe("Keywords to filter"),
      language: z.string().optional().default("en").describe("Language code"),
      ontology: z.string().optional().default("headai").describe("Ontology: headai, esco, lightcast"),
      search_year: z.union([z.string(), z.number()]).optional().describe("Year filter (required for doaj_articles, investment_data, news, tiedejatutkimus)"),
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

      // ── FIX: estimate_size returns -1 → helpful error messaging ──
      const rawData = response.data;
      const resultNum = typeof rawData === "number" ? rawData
        : (typeof rawData === "object" && rawData !== null && "total_results" in rawData) ? rawData.total_results
        : (typeof rawData === "string" && rawData.trim() === "-1") ? -1
        : null;

      if (resultNum === -1) {
        const unsupportedCombos = [
          { ds: "news", issue: "news dataset does not support all filter combinations" },
          { ds: "curriculum", issue: "curriculum with search_text or city filter often returns -1" },
        ];
        const hint = unsupportedCombos.find(c => c.ds === params.dataset)?.issue
          || "this dataset+filter combination doesn't support pre-estimation";
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              estimate: -1,
              meaning: `Pre-estimation unavailable — ${hint}.`,
              suggestion: "Run headai_build_knowledge_graph with size=50 directly — it's fast and will show actual results (or an empty graph if no data matches).",
            })
          }]
        };
      }

      const text = typeof rawData === "string" ? rawData : JSON.stringify(rawData, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Headai Career Intelligence — Three-agent composite tools
// Skills Profiler / Career Navigator / Foresight Agent
// (Renamed from ENOT 2026-04-16)
// Uses headai ontology internally for quality; translate to ESCO via
// headai_translate_graph on export to ELM-compliant systems.
// ═══════════════════════════════════════════════════════════════════════════

const ENOT_ONTOLOGY = "headai";

// ── Helper: build skills graph from CV + optional KOSKI ────────────────────
async function enotBuildSkillsGraph(
  apiKey: string,
  cvText: string,
  koskiText: string | undefined,
  language: string,
  legend: string
): Promise<string> {
  const cvInitial = await headaiPost<AsyncJobResponse>(apiKey, "TextToGraph", {
    text: cvText,
    language,
    ontology: ENOT_ONTOLOGY,
    legend,
    word_type: "only_compounds",
    high_privacy_mode: false,
    update: "false",
    output: "json",
  });
  const cvReady = await pollUntilReady(apiKey, cvInitial) as Record<string, unknown>;
  let graphUrl = (cvReady.url || cvReady.location || cvInitial.location || "") as string;

  if (koskiText && koskiText.length > 20) {
    const koskiInitial = await headaiPost<AsyncJobResponse>(apiKey, "TextToGraph", {
      text: koskiText,
      language,
      ontology: ENOT_ONTOLOGY,
      legend: `${legend} — KOSKI`,
      word_type: "only_compounds",
      high_privacy_mode: false,
      update: "false",
      output: "json",
    });
    const koskiReady = await pollUntilReady(apiKey, koskiInitial) as Record<string, unknown>;
    const koskiUrl = (koskiReady.url || koskiReady.location || koskiInitial.location || "") as string;

    const joinResp = await headaiPost<AsyncJobResponse>(apiKey, "JoinKnowledgeGraphs", {
      urls: `${graphUrl},${koskiUrl}`,
      title: `${legend} — merged`,
      output: "json",
    });
    await pollUntilReady(apiKey, joinResp);
    graphUrl = (joinResp.location || graphUrl) as string;
  }

  return graphUrl;
}

// ── Helper: fetch graph JSON and extract top nodes ─────────────────────────
async function enotFetchTopSkills(graphUrl: string, limit: number = 30): Promise<{ topSkills: Array<{ label: unknown; weight: unknown; group: unknown }>; skillCount: number }> {
  try {
    const graphFetch = await axios.get(graphUrl, { timeout: 60000 });
    const gd = graphFetch.data as Record<string, unknown>;
    const inner = (gd && typeof gd === "object" && gd.data && typeof gd.data === "object")
      ? gd.data as Record<string, unknown>
      : gd;
    const nodes = Array.isArray(inner.nodes) ? inner.nodes as Array<Record<string, unknown>> : [];
    const topSkills = [...nodes]
      .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0) || Number(b.value ?? 0) - Number(a.value ?? 0))
      .slice(0, limit)
      .map(n => ({ label: n.label, weight: n.weight, group: n.group }));
    return { topSkills, skillCount: nodes.length };
  } catch (_err) {
    return { topSkills: [], skillCount: 0 };
  }
}

// ── Tool: Skills Profiler (Career Intelligence) ──────────────────

server.registerTool(
  "headai_enot_skills_agent",
  {
    title: "Skills Profiler",
    description: `Headai Career Intelligence — builds an individual's Digital Twin skill profile from unstructured text (CV, free description, portfolio, hobbies) and optional structured data (KOSKI). Part of the Career Intelligence suite.

HUMAN-IN-THE-LOOP GATE: First call returns a preview of extracted skills + preview_hash. User reviews skills. Second call with SAME params + preview_hash stores the profile. Optionally pass rejected_skills to remove noise or approved_skills to keep only specific skills.

USE WHEN: user provides personal text (CV, portfolio, LinkedIn, KOSKI records, description of hobbies/volunteer work) and wants to build/update their skill profile.
Intent signals: "luo profiili", "tunnista osaamiseni", "rakenna digitaalinen kaksonen", "analyse my CV", "what skills do I have".

FLOW:
  Phase 1 (no preview_hash): TextToGraph on CV → optional TextToGraph on KOSKI + JoinGraphs → return preview + hash
  Phase 2 (with preview_hash): rebuild graph → optional ModifyKnowledgeGraph filter → DigitalTwinStorage/AddToTwin

ONTOLOGY: Uses "headai" internally for best extraction quality. Translate to ESCO via headai_translate_graph when exporting for ELM compliance.

Args:
  - cv_text (required): CV or free-text skill description. Hobbies, volunteer work, portfolio content all valid.
  - koski_text (optional): KOSKI structured education records as text (processed separately and joined)
  - user_key (required): Unique Digital Twin identifier (e.g., "user_123")
  - language (default "en"): en / fi / sv
  - legend (optional): Graph label
  - preview_hash: Leave empty on first call. Pass returned hash on second call to confirm.
  - rejected_skills (optional): Comma-separated skill labels to remove before storing
  - approved_skills (optional): Comma-separated skill labels to keep (all others removed). Mutually exclusive with rejected_skills.

Phase 1 return: status "preview", graph_url, visualizer_url, top_skills[], preview_hash, next_action
Phase 2 return: status "stored", twin_key, final_skill_count, graph_url, visualizer_url`,
    inputSchema: {
      cv_text: z.string().min(20, "cv_text must be at least 20 characters").describe("CV / free text / portfolio / hobby description"),
      koski_text: z.string().optional().describe("Optional KOSKI text — processed separately and joined with CV graph"),
      user_key: z.string().min(1).describe("Unique Digital Twin identifier for this user"),
      language: z.string().default("en").describe("ISO language code (en, fi, sv)"),
      legend: z.string().optional().describe("Optional graph label"),
      preview_hash: z.string().optional().describe("Leave empty on first call. After reviewing preview, call again with SAME params + this hash to store."),
      rejected_skills: z.string().optional().describe("Comma-separated skill labels to remove before storing (human validation filter)"),
      approved_skills: z.string().optional().describe("Comma-separated skill labels to keep (removes all others). Mutually exclusive with rejected_skills."),
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
      if (params.rejected_skills && params.approved_skills) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Use rejected_skills OR approved_skills, not both." }) }], isError: true };
      }

      const legend = params.legend || `Skills Profile: ${params.user_key}`;

      // Canonical params for hashing (exclude preview_hash + filter args — filters applied post-confirm)
      const canonical: Record<string, unknown> = {
        cv_text: params.cv_text,
        koski_text: params.koski_text || "",
        user_key: params.user_key,
        language: params.language,
        legend,
      };
      const expectedHash = computePreviewHash(canonical);

      // ── Phase 1: no hash or mismatched → build preview ──
      if (!params.preview_hash || params.preview_hash !== expectedHash) {
        const graphUrl = await enotBuildSkillsGraph(apiKey, params.cv_text, params.koski_text, params.language, legend);
        const { topSkills, skillCount } = await enotFetchTopSkills(graphUrl, 30);

        registerPreviewHash(expectedHash);
        const visualizerUrl = `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(graphUrl)}`;

        return { content: [{ type: "text", text: JSON.stringify({
          status: "preview",
          phase: "review_skills",
          user_key: params.user_key,
          graph_url: graphUrl,
          visualizer_url: visualizerUrl,
          skill_count: skillCount,
          top_skills: topSkills,
          preview_hash: expectedHash,
          next_action: "Review the skills above. To store this profile, call again with the SAME parameters + preview_hash. Optionally pass rejected_skills or approved_skills to filter before storing.",
          ontology: ENOT_ONTOLOGY,
          note: "Stored with headai ontology. Translate to ESCO via headai_translate_graph if ELM export is needed.",
        }) }] };
      }

      // ── Phase 2: hash matches → time lock → optional filter → store ──
      const timeLock = isHashReady(params.preview_hash);
      if (!timeLock.ready) {
        return { content: [{ type: "text", text: JSON.stringify({
          status: "waiting",
          reason: "preview_cooldown",
          seconds_remaining: timeLock.waitSeconds,
          message: "Skills were just previewed. Allow review time before storing."
        }) }] };
      }
      previewTimestamps.delete(params.preview_hash);

      // Rebuild graph (canonical inputs → near-identical result; avoids stale state)
      let graphUrl = await enotBuildSkillsGraph(apiKey, params.cv_text, params.koski_text, params.language, legend);

      // Optional filter via ModifyKnowledgeGraph
      if (params.rejected_skills || params.approved_skills) {
        const modifyPayload: Record<string, unknown> = {
          url: graphUrl,
          output: "json",
        };
        if (params.rejected_skills) modifyPayload.remove = params.rejected_skills;
        if (params.approved_skills) modifyPayload.keywords = params.approved_skills;

        const modifyResp = await headaiPost<AsyncJobResponse>(apiKey, "ModifyKnowledgeGraph", modifyPayload);
        await pollUntilReady(apiKey, modifyResp);
        graphUrl = (modifyResp.location || graphUrl) as string;
      }

      // Store to Digital Twin (fetch graph JSON + post as twin_graph)
      const graphResponse = await axios.get(graphUrl, { timeout: 60000 });
      const storeResult = await headaiPost(apiKey, "DigitalTwinStorage/AddToTwin", {
        twin_key: params.user_key,
        twin_graph: graphResponse.data,
      });

      // Count final skills
      let finalSkillCount = 0;
      try {
        const gd = graphResponse.data as Record<string, unknown>;
        const inner = (gd && typeof gd === "object" && gd.data && typeof gd.data === "object")
          ? gd.data as Record<string, unknown>
          : gd;
        const nodes = Array.isArray(inner.nodes) ? inner.nodes : [];
        finalSkillCount = nodes.length;
      } catch (_err) { /* ignore */ }

      const visualizerUrl = `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(graphUrl)}`;

      return { content: [{ type: "text", text: JSON.stringify({
        status: "stored",
        twin_key: params.user_key,
        final_skill_count: finalSkillCount,
        graph_url: graphUrl,
        visualizer_url: visualizerUrl,
        ontology: ENOT_ONTOLOGY,
        store_response: storeResult,
        message: "Digital Twin stored. Retrieve later via headai_digital_twin (operation: 'get', twin_key: this user_key).",
      }) }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Career Navigator (Career Intelligence) ───────

server.registerTool(
  "headai_enot_career_agent",
  {
    title: "Career Navigator",
    description: `Headai Career Intelligence — compares an individual's Digital Twin against a target (job market, free-text role, or employer profile) and produces gap analysis with explainable training recommendations or job matches. Part of the Career Intelligence suite.

USE WHEN: user wants to know how their skills compare to a role, what training they need, or which jobs match. Intent signals: "gap-analyysi", "osaamiskapeikko", "vertaa profiiliani", "mitä minulta puuttuu", "suosittele koulutusta", "career match", "what training do I need".

FLOW:
  1. digital_twin (get) — retrieve user's Digital Twin via GetSecureShareLink → URL
  2. Build target graph based on target_type:
     - "job_market": build_knowledge_graph on job_ads dataset with search_text
     - "text": text_to_graph on target_value (dream job description)
     - "twin": retrieve another twin_key (employer role profile)
  3. Scorecard (left=user twin URL, right=target URL) → gap list (group 3)
  4. Based on mode:
     - "analyze" (default): return Scorecard + gaps, no recommendations
     - "training": also run Compass sequentially across namespaces; link each course to the specific gaps it addresses (via new_skills ∩ gaps)
     - "jobs": also run get_jobs_by_text on user's top skills
     - "all": both training + jobs

HARD RULES:
  - Never auto-routes between training/jobs. User must explicitly choose mode.
  - MAX_CONCURRENT_COMPASS=1 — namespaces processed sequentially, not parallel.
  - Recommendations always include addresses_gaps[] so the user sees which gap each course/job closes.
  - Pilot default namespaces: "Laurea,Stadin" — pass namespaces arg to override.

Args:
  - user_key (required): Digital Twin key for the individual
  - target_type (required): "job_market" | "text" | "twin"
  - target_value (required): search_text for job_market, free text for text, twin_key for twin
  - language (default "en"): en / fi / sv
  - mode (default "analyze"): "analyze" | "training" | "jobs" | "all"
  - namespaces (default "Laurea,Stadin"): comma-separated Compass namespaces (training mode only)
  - area (optional): city for jobs mode (e.g. "Helsinki")
  - country (optional, default "fi"): ISO code for jobs mode
  - search_year (optional, default current): year filter for job_market target

Returns: status, scorecard_url, match_score, common_skills[], user_only_skills[], missing_skills[] (gaps), and per-mode: training_recommendations[] (with addresses_gaps[]) or job_matches[].`,
    inputSchema: {
      user_key: z.string().min(1).describe("Digital Twin key for the user"),
      target_type: z.enum(["job_market", "text", "twin"]).describe("Target comparison type"),
      target_value: z.string().min(1).describe("search_text (job_market), free text (text), or twin_key (twin)"),
      language: z.string().default("en").describe("ISO language code (en, fi, sv)"),
      mode: z.enum(["analyze", "training", "jobs", "all"]).default("analyze").describe("Analysis mode"),
      namespaces: z.string().default("Laurea,Stadin").describe("Comma-separated Compass namespaces (training mode)"),
      area: z.string().optional().describe("City for jobs mode (e.g. 'Helsinki')"),
      country: z.string().default("fi").describe("ISO country code for jobs mode"),
      search_year: z.union([z.string(), z.number()]).optional().describe("Year filter for job_market target (default: current year)"),
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
      // ── Step 1: Retrieve user's Digital Twin as a URL ──
      const shareResult = await headaiGet<Record<string, unknown>>(apiKey, "DigitalTwinStorage/GetSecureShareLink", {
        twin_key: params.user_key,
      });
      const userTwinUrl = (shareResult.url || shareResult.location || shareResult.secure_share_link || shareResult.share_link || "") as string;
      if (!userTwinUrl) {
        return { content: [{ type: "text", text: JSON.stringify({
          error: `Could not retrieve Digital Twin for user_key "${params.user_key}". Check the key exists or use the Skills Profiler (headai_enot_skills_agent) to create one.`,
          raw: shareResult,
        }) }], isError: true };
      }

      // ── Step 2: Build the target graph ──
      let targetUrl = "";
      let targetLabel = "";

      if (params.target_type === "job_market") {
        targetLabel = `Job market: ${params.target_value}`;
        const currentYear = new Date().getFullYear();
        const year = params.search_year !== undefined ? Number(params.search_year) : currentYear;
        const bkgPayload: Record<string, unknown> = {
          dataset: "job_ads",
          language: params.language,
          ontology: ENOT_ONTOLOGY,
          search_text: params.target_value,
          search_year: year,
          size: 100,
          legend: targetLabel,
          output: "json",
        };
        if (params.country) bkgPayload.country = params.country;
        const bkgResp = await headaiPost<AsyncJobResponse>(apiKey, "BuildKnowledgeGraph", bkgPayload);
        await pollUntilReady(apiKey, bkgResp); // wait for graph to be ready
        targetUrl = (bkgResp.location || "") as string; // URL is in the initial response
      } else if (params.target_type === "text") {
        targetLabel = "Dream job / target role";
        const t2gInitial = await headaiPost<AsyncJobResponse>(apiKey, "TextToGraph", {
          text: params.target_value,
          language: params.language,
          ontology: ENOT_ONTOLOGY,
          legend: targetLabel,
          word_type: "only_compounds",
          high_privacy_mode: false,
          update: "false",
          output: "json",
        });
        const t2gReady = await pollUntilReady(apiKey, t2gInitial) as Record<string, unknown>;
        targetUrl = (t2gReady.url || t2gReady.location || t2gInitial.location || "") as string;
      } else {
        // target_type === "twin"
        targetLabel = `Employer role profile: ${params.target_value}`;
        const employerShare = await headaiGet<Record<string, unknown>>(apiKey, "DigitalTwinStorage/GetSecureShareLink", {
          twin_key: params.target_value,
        });
        targetUrl = (employerShare.url || employerShare.location || employerShare.secure_share_link || employerShare.share_link || "") as string;
      }

      if (!targetUrl) {
        return { content: [{ type: "text", text: JSON.stringify({
          error: `Could not build target graph for ${params.target_type}="${params.target_value}"`,
        }) }], isError: true };
      }

      // ── Step 3: Scorecard (user vs target) ──
      const scorecardResp = await headaiPost<AsyncJobResponse>(apiKey, "Scorecard", {
        map_url_1: userTwinUrl,
        map_url_2: targetUrl,
        legend_1: `User profile: ${params.user_key}`,
        legend_2: targetLabel,
        language: params.language,
        ontology: ENOT_ONTOLOGY,
        output: "json",
      });
      await pollUntilReady(apiKey, scorecardResp);
      const scorecardUrl = (scorecardResp.location || "") as string;

      // Fetch scorecard JSON to extract nodes by group
      let commonSkills: string[] = [];
      let userOnlySkills: string[] = [];
      let missingSkills: string[] = [];
      let matchScore: unknown = null;
      try {
        const scFetch = await axios.get(scorecardUrl, { timeout: 60000 });
        const sg = scFetch.data as Record<string, unknown>;
        const inner = (sg && typeof sg === "object" && sg.data && typeof sg.data === "object")
          ? sg.data as Record<string, unknown>
          : sg;
        const nodes = Array.isArray(inner.nodes) ? inner.nodes as Array<Record<string, unknown>> : [];
        for (const n of nodes) {
          const label = String(n.label ?? "");
          const group = String(n.group ?? "");
          if (group === "1") commonSkills.push(label);
          else if (group === "2") userOnlySkills.push(label);
          else if (group === "3") missingSkills.push(label);
        }
        const scores = inner.scores as Record<string, unknown> | undefined;
        if (scores && typeof scores === "object") matchScore = scores.match_score ?? scores.score ?? null;
      } catch (_err) {
        // Scorecard fetch failed — continue with empty lists
      }

      const visualizerUrl = scorecardUrl
        ? `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(scorecardUrl)}`
        : "";

      // ── Step 4: Mode-based enrichment ──
      const out: Record<string, unknown> = {
        status: "ready",
        user_key: params.user_key,
        target_type: params.target_type,
        target_label: targetLabel,
        scorecard_url: scorecardUrl,
        visualizer_url: visualizerUrl,
        match_score: matchScore,
        common_skills: commonSkills.slice(0, 50),
        user_only_skills: userOnlySkills.slice(0, 50),
        missing_skills: missingSkills.slice(0, 50),
        mode: params.mode,
      };

      const needsTraining = params.mode === "training" || params.mode === "all";
      const needsJobs = params.mode === "jobs" || params.mode === "all";

      // ── Path A: Training recommendations via Compass ──
      if (needsTraining && missingSkills.length > 0) {
        const userTopSkillsForCompass = [...commonSkills, ...userOnlySkills].slice(0, 30);
        const interestGaps = missingSkills.slice(0, 15);
        const namespaceList = params.namespaces.split(",").map(s => s.trim()).filter(s => s.length > 0);

        const allRecommendations: Array<Record<string, unknown>> = [];
        const missingSkillSet = new Set(missingSkills.map(s => s.toLowerCase()));

        // Sequential Compass calls (MAX_CONCURRENT_COMPASS=1)
        for (const ns of namespaceList) {
          try {
            const compassResult = await headaiPost<Record<string, unknown>>(apiKey, "Compass", {
              output: "json",
              data: {
                namespace: ns,
                request: ["match", "zpd"],
                skills: userTopSkillsForCompass,
                interests: interestGaps,
                language: params.language,
              },
            });
            // Compass response contains recommendations_match / recommendations_zpd arrays
            for (const key of Object.keys(compassResult)) {
              if (!key.startsWith("recommendations_")) continue;
              const recs = compassResult[key];
              if (!Array.isArray(recs)) continue;
              for (const rec of recs.slice(0, 10)) {
                const recObj = rec as Record<string, unknown>;
                const newSkills = Array.isArray(recObj.new_skills) ? recObj.new_skills as string[] : [];
                // Intersect new_skills with missing gaps
                const addressesGaps = newSkills.filter(s => missingSkillSet.has(String(s).toLowerCase()));
                allRecommendations.push({
                  namespace: ns,
                  mode: key.replace("recommendations_", ""),
                  title: recObj.title || recObj.label || recObj.name,
                  description: recObj.description,
                  url: recObj.url,
                  score: recObj.score || recObj.match_score,
                  new_skills: newSkills.slice(0, 10),
                  addresses_gaps: addressesGaps,
                  gap_coverage: addressesGaps.length,
                });
              }
            }
          } catch (compErr) {
            // Log and continue with remaining namespaces
            allRecommendations.push({ namespace: ns, error: handleApiError(compErr) });
          }
        }

        // Sort recommendations by gap coverage (most gaps addressed first)
        allRecommendations.sort((a, b) => Number(b.gap_coverage ?? 0) - Number(a.gap_coverage ?? 0));
        out.training_recommendations = allRecommendations.slice(0, 20);
        out.training_note = `Courses ranked by how many of your ${missingSkills.length} missing skills they address. addresses_gaps[] shows the specific gaps each course closes.`;
      } else if (needsTraining) {
        out.training_note = "No missing skills detected — your profile already covers the target. Consider mode='jobs' to find matching positions.";
      }

      // ── Path B: Job matches via get_jobs_by_text ──
      if (needsJobs) {
        const topSkillsForJobs = [...commonSkills, ...userOnlySkills].slice(0, 15).join(",");
        const area = params.area || "Helsinki";
        try {
          const jobsResult = await headaiPost<Record<string, unknown>>(apiKey, "Utils", {
            action: "get_jobs_by_text",
            search: params.target_type === "job_market" ? params.target_value : "",
            keywords: topSkillsForJobs,
            area,
            country: params.country,
            language: params.language,
            limit: 20,
          });
          out.job_matches = jobsResult;
          out.jobs_area = area;
        } catch (jobErr) {
          out.job_matches_error = handleApiError(jobErr);
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── Tool: Foresight Agent (Career Intelligence — Employer) ───────────
//
// PRIVACY ARCHITECTURE (v1 — stateless):
//   • Caller passes employee_keys AND excluded_keys explicitly. The caller's
//     consent management system is responsible for populating excluded_keys.
//   • Tool enforces minimum-N AFTER exclusion as a HARD BLOCK — not a warning.
//     If N < min_n, returns error with no data leakage (no participant count).
//   • Individual Digital Twin URLs are NEVER returned. Only the joined aggregate.
//   • Compass is NEVER called here — employer flow must not generate individual
//     recommendations. Training suggestions belong to Career Navigator only.
//
// v2 work: persistent consent registry, aggregate lineage tracking (which twins
// built which aggregate), audit trail for GDPR Article 30, right-to-erasure
// invalidation of cached aggregates.

const ENOT_DEFAULT_MIN_N = 5;

server.registerTool(
  "headai_enot_forecasting_agent",
  {
    title: "Foresight Agent",
    description: `Headai Career Intelligence — produces an anonymised, aggregated skills picture of an organisation. The employer NEVER sees individuals. Part of the Career Intelligence suite.

USE WHEN: employer or HR wants to understand their organisation's collective skills, compare them to employer-defined needs, or run strategic workforce forecasting. Intent signals: "organisaation osaamistilanne", "henkilöstön osaamiskartta", "anonymisoitu tilannekuva", "workforce skills map", "ennakointiraportti", "org-level gap".

FLOW:
  1. Filter: consenting = employee_keys − excluded_keys
  2. HARD BLOCK if consenting.length < min_n (default 5). Returns error, no data, no count.
  3. For each consenting twin: DigitalTwinStorage/GetSecureShareLink → URL
  4. JoinKnowledgeGraphs on all URLs → single aggregate graph
  5. Optional: if employer_needs_text provided, TextToGraph on it then Scorecard(aggregate, needs)
  6. Optional: run_analyst report 300 (Scorecard Quick Opportunities) for strategic summary
  7. Optional: BuildSignals for trend overlay (if include_signals=true)

HARD RULES (enforced in code, not UI warnings):
  • min_n check blocks BEFORE any data fetch — prevents individual inference from small groups
  • excluded_keys filtered BEFORE join — not after
  • Returns aggregate graph URL only — NEVER individual twin URLs
  • Compass is not available in this flow — individual recommendations belong to Ura-agentti
  • If min_n fails, error message does NOT reveal how many keys were provided

Args:
  - employee_keys (required): comma-separated list of ALL employee twin_keys
  - excluded_keys (optional): comma-separated list of twin_keys who opted out (filtered before join)
  - min_n (default 5): minimum number of consenting employees required before producing any output
  - employer_needs_text (optional): free text describing skill needs for comparison
  - language (default "en")
  - include_signals (default false): also compute BuildSignals for trend overlay
  - include_quick_opportunities (default true): run analyst report 300 on the Scorecard result

Returns (on success): status "ready", aggregate_graph_url, visualizer_url, participant_count, aggregate_top_skills, optional scorecard_url, optional gaps[] (employer needs not covered), optional strengths[] (employer needs already covered), optional strategic_summary, optional signals_url.
Returns (on min_n block): status "blocked", reason "insufficient_participants", message only — no count, no data.`,
    inputSchema: {
      employee_keys: z.string().min(1).describe("Comma-separated Digital Twin keys for ALL employees"),
      excluded_keys: z.string().optional().describe("Comma-separated twin_keys who opted out — MUST come from your consent system"),
      min_n: z.number().default(ENOT_DEFAULT_MIN_N).describe("Minimum consenting employees required. Hard block if under threshold."),
      employer_needs_text: z.string().optional().describe("Free text describing employer skill needs for gap analysis"),
      language: z.string().default("en").describe("ISO language code (en, fi, sv)"),
      include_signals: z.boolean().default(false).describe("Also compute BuildSignals for trend overlay"),
      include_quick_opportunities: z.boolean().default(true).describe("Run run_analyst report 300 on the Scorecard result"),
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
      // ── Step 1: Parse + filter opt-outs BEFORE any data fetch ──
      const allKeys = params.employee_keys.split(",").map(s => s.trim()).filter(s => s.length > 0);
      const excluded = new Set(
        (params.excluded_keys || "").split(",").map(s => s.trim()).filter(s => s.length > 0)
      );
      const consentingKeys = allKeys.filter(k => !excluded.has(k));

      // ── Step 2: HARD BLOCK on minimum N — before any data is touched ──
      if (consentingKeys.length < params.min_n) {
        // Intentionally do NOT reveal consentingKeys.length or allKeys.length.
        return { content: [{ type: "text", text: JSON.stringify({
          status: "blocked",
          reason: "insufficient_participants",
          message: `Not enough participants to show data while protecting privacy. Minimum group size: ${params.min_n}.`,
        }) }] };
      }

      // ── Step 3: Resolve each consenting twin to a URL ──
      const twinUrls: string[] = [];
      const failedKeys: string[] = [];
      for (const key of consentingKeys) {
        try {
          const share = await headaiGet<Record<string, unknown>>(apiKey, "DigitalTwinStorage/GetSecureShareLink", {
            twin_key: key,
          });
          const url = (share.url || share.location || share.secure_share_link || share.share_link || "") as string;
          if (url) twinUrls.push(url);
          else failedKeys.push(key);
        } catch (_err) {
          failedKeys.push(key);
        }
      }

      // Re-check threshold after resolution failures
      if (twinUrls.length < params.min_n) {
        return { content: [{ type: "text", text: JSON.stringify({
          status: "blocked",
          reason: "insufficient_resolvable_twins",
          message: `Not enough retrievable Digital Twins to show data while protecting privacy. Minimum: ${params.min_n}.`,
        }) }] };
      }

      // ── Step 4: Join all graphs into one aggregate ──
      const joinResp = await headaiPost<AsyncJobResponse>(apiKey, "JoinKnowledgeGraphs", {
        urls: twinUrls.join(","),
        title: `Org aggregate (${twinUrls.length} participants)`,
        output: "json",
      });
      await pollUntilReady(apiKey, joinResp);
      const aggregateUrl = (joinResp.location || "") as string;

      if (!aggregateUrl) {
        return { content: [{ type: "text", text: JSON.stringify({
          status: "error",
          message: "Failed to build aggregate graph from consenting twins.",
        }) }], isError: true };
      }

      const visualizerUrl = `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(aggregateUrl)}`;

      // Extract top skills from aggregate for display
      const { topSkills: aggregateTopSkills, skillCount: aggregateSkillCount } = await enotFetchTopSkills(aggregateUrl, 30);

      const out: Record<string, unknown> = {
        status: "ready",
        aggregate_graph_url: aggregateUrl,
        visualizer_url: visualizerUrl,
        participant_count: twinUrls.length,
        aggregate_skill_count: aggregateSkillCount,
        aggregate_top_skills: aggregateTopSkills,
        privacy_note: "Individual Digital Twins are never exposed. Only the anonymised aggregate is returned.",
      };

      // ── Step 5: Optional — Scorecard vs employer needs ──
      if (params.employer_needs_text && params.employer_needs_text.trim().length > 20) {
        const needsInitial = await headaiPost<AsyncJobResponse>(apiKey, "TextToGraph", {
          text: params.employer_needs_text,
          language: params.language,
          ontology: ENOT_ONTOLOGY,
          legend: "Employer skill needs",
          word_type: "only_compounds",
          high_privacy_mode: false,
          update: "false",
          output: "json",
        });
        const needsReady = await pollUntilReady(apiKey, needsInitial) as Record<string, unknown>;
        const needsUrl = (needsReady.url || needsReady.location || needsInitial.location || "") as string;

        if (needsUrl) {
          const scResp = await headaiPost<AsyncJobResponse>(apiKey, "Scorecard", {
            map_url_1: aggregateUrl,
            map_url_2: needsUrl,
            legend_1: "Org aggregate",
            legend_2: "Employer needs",
            language: params.language,
            ontology: ENOT_ONTOLOGY,
            output: "json",
          });
          await pollUntilReady(apiKey, scResp);
          const scUrl = (scResp.location || "") as string;

          // Extract groups from scorecard
          const strengths: string[] = [];
          const gaps: string[] = [];
          try {
            const scFetch = await axios.get(scUrl, { timeout: 60000 });
            const sg = scFetch.data as Record<string, unknown>;
            const inner = (sg && typeof sg === "object" && sg.data && typeof sg.data === "object")
              ? sg.data as Record<string, unknown>
              : sg;
            const nodes = Array.isArray(inner.nodes) ? inner.nodes as Array<Record<string, unknown>> : [];
            for (const n of nodes) {
              const label = String(n.label ?? "");
              const group = String(n.group ?? "");
              if (group === "1") strengths.push(label);
              else if (group === "3") gaps.push(label);
            }
          } catch (_err) { /* ignore */ }

          out.scorecard_url = scUrl;
          out.scorecard_visualizer_url = scUrl
            ? `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(scUrl)}`
            : "";
          out.strengths = strengths.slice(0, 50);
          out.gaps = gaps.slice(0, 50);

          // Optional: run_analyst report 300 (Scorecard Quick Opportunities)
          if (params.include_quick_opportunities && scUrl) {
            try {
              const analystResp = await headaiPost<AsyncJobResponse>(apiKey, "Analyst", {
                url: scUrl,
                report: 300,
                output: "json",
              });
              const analystData = await pollUntilReady(apiKey, analystResp);
              out.strategic_summary = analystData;
            } catch (analystErr) {
              out.strategic_summary_error = handleApiError(analystErr);
            }
          }
        }
      }

      // ── Step 6: Optional — BuildSignals for trend overlay ──
      if (params.include_signals) {
        try {
          const signalsResp = await headaiPost<AsyncJobResponse>(apiKey, "BuildSignals", {
            urls: aggregateUrl,
            title: "Org skills signals",
            output: "json",
          });
          await pollUntilReady(apiKey, signalsResp); // wait for signals to be ready
          const signalsUrl = (signalsResp.location || "") as string; // URL is in the initial response
          out.signals_url = signalsUrl;
          out.signals_visualizer_url = signalsUrl
            ? `https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=${encodeURIComponent(signalsUrl)}`
            : "";
        } catch (signalsErr) {
          out.signals_error = handleApiError(signalsErr);
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ── MCP Prompts (built-in skills served to all connected clients) ──────────

server.prompt(
  "headai-orchestrator",
  "LOAD THIS FIRST. You are a workforce intelligence orchestrator. This prompt tells you how to interpret any user request and chain Headai tools into the right workflow — like a smart assistant that figures out what the user needs.",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `# You Are a Headai Workforce Intelligence Orchestrator

You have access to Headai tools for workforce intelligence. Your job: understand what the user needs, ask when unclear, choose the right tools, and present results conversationally. The user should never need to know which tools exist.

## RULE #1: CLARIFY BEFORE ACTING

If the user's intent is unclear or underspecified, ask a clarification question before choosing a method.

Ambiguous requests that REQUIRE clarification:
- "Analysoi osaaminen" → Ask: "Current state, comparison, or trends?"
- "Tee kartta" → Ask: "What domain? Which dataset? What location/time?"
- "Help me with skills" → Ask: "Are you looking at your own skills, a job market, or education?"

Ask ONE focused question, not multiple. Keep it simple and non-technical.

When genuinely unclear: default to Snapshot first, present results, then guide: "Now that we see the landscape, would you like to compare this to something, see how it's changed over time, or get recommendations?"

## INTENT DETECTION

Read the user's message. Detect their language (fi/en/sv). Classify intent:

| Intent | Trigger phrases (EN) | Trigger phrases (FI) | Method |
|--------|---------------------|---------------------|--------|
| EXPLORE | "what skills are needed", "map the", "show me", "overview", "landscape" | "osaamistarve", "osaamiskartta", "tilannekuva", "nykytila", "mitä taitoja tarvitaan" | Snapshot |
| PARSE TEXT | user pastes text (CV, job posting, article) | user pastes text | TextToGraph |
| COMPARE | "compare", "gap", "what's missing", "differences between" | "vertaa", "vertailu", "katve", "puute", "mikä puuttuu", "erot" | Scorecard |
| TREND | "how has X changed", "what's emerging", "trends" | "muutos", "kehitys", "trendit", "miten on muuttunut", "ennuste" | Signals |
| RECOMMEND | "what should I learn", "recommend", "what next", "what jobs fit" | "suositukset", "miten täyttää", "mitä seuraavaksi", "zpd" | Compass |
| CAREER CHANGE | "switch from X to Y", "career change", "thinking about moving to" | "alanvaihto", "haluaisin siirtyä" | Full chain |
| FIND JOBS | "find jobs", "what's available", "job openings" | "etsi työpaikkoja", "avoimet paikat" | Job search |
| STORE PROFILE | "save my profile", "remember my skills", "digital twin" | "tallenna profiilini" | Digital Twin |
| EXPLAIN | "what is a knowledge graph", "what do colors mean", "how to read this" | "mitä kartta näyttää", "mitä värit tarkoittavat" | Answer from knowledge below |

**CRITICAL: Time reference alone ≠ Signals.** "AI skills 2025" → Snapshot. ONLY explicit change language ("how has it changed", "trends", "muutos") → Signals.

## METHODS & RULES

| Method | Tool | Requires | Rules |
|--------|------|----------|-------|
| Snapshot | headai_build_knowledge_graph | 1 dataset + search_text | ALWAYS start with size=50 for a quick first look. After presenting results, ask: "Want me to build a deeper analysis? It will take a bit longer but gives richer results." Then use 200-500. Max 1000. Use location in payload fields (city/country), not just in search_text. |
| TextToGraph | headai_text_to_graph | Free text + language | Do NOT auto-chain BuildKnowledgeGraph after this. |
| Score | headai_scorecard | 2 graphs + explicit comparison intent | Two snapshots alone do NOT trigger Scorecard. User must ask to compare. Keep compared graphs similar size. |
| Signals | headai_build_signals | 2+ chronological snapshots + explicit change intent | 3+ recommended for robust trends. predict=false unless user says "forecast"/"ennuste". Keep same dataset across snapshots. |
| Compass | headai_compass | skills/interests arrays + explicit recommendation intent | Always LAST in any chain. Needs current skills + target interests as arrays, not graph URLs. |

**Fixed order:** Snapshot/TextToGraph → Score or Signals → Compass (always last)
**Chain depth guardrail:** Default to 2-3 steps. Do NOT build deep chains unless user explicitly asks.

## LANGUAGE & TRANSLATION

1. Detect user_language from their message (fi/en/sv)
2. Set payload.language = user_language (exception: doaj_articles ALWAYS = "en")
3. Add headai_translate_graph ONLY when source language ≠ user_language
4. Never add conditional translations ("if English, translate")
5. Never use high_privacy_mode: true — it breaks downstream workflows

## search_text RULES

- Exactly 20 domain-specific keywords, comma-separated
- Vocabulary MUST match dataset: labour terms for job_ads, academic terms for doaj_articles, institutional terms for curriculum
- The legend is just a label — it should not be used as search_text
- No generic filler (experience, skills, collaboration, development)
- Same language as user prompt (exception: doaj_articles always English keywords)
- Hyphens = AND (machine-learning), commas = OR

## DATASETS & DATA COVERAGE

| Dataset | Horizon | Sources | Rules | Coverage |
|---------|---------|---------|-------|----------|
| job_ads | Present | TMT, Duunitori, MOL, Eures | Supports country/city. Default choice. | Strong: fi, fr, se, de, nl. 256+ cities. Helsinki 811K, Tampere 355K, Turku 289K, Stockholm 236K |
| doaj_articles | 5-10yr future | DOAJ, TiedeJaTutkimus | ALWAYS language="en", REQUIRES search_year | 1M+ articles (2025) |
| investment_data | 1-3yr future | Investment datasets | REQUIRES search_year | 81K records |
| news | Recent | YLE, BBC, Guardian, TechCrunch, Al Jazeera, Kauppalehti, NYT, SVT, ZDNet, Euronews + more | REQUIRES search_year | Multiple languages |
| curriculum | Current | Finnish HEIs + international | For Finnish institutions | See institutions list below |
| custom/imported | Any | Customer data enriched by Headai | For client-specific data | Varies |

**Finnish institutions in curriculum data:** University of Helsinki, Aalto University, University of Jyvaskyla, Metropolia, Tuni, XAMK, TuAMK, LUT, Laurea, TAMK, HAMK, SAMK, OpenXAMK, eperusteet, koulutus.fi
**International education:** moncompteformation (109K), inokufu udemy (56K), classcentral (20K), onisep (33K)

Cross-horizon Signals: job_ads (now) → investment_data (1-3yr) → doaj_articles (5-10yr)

## COMPASS NAMESPACES

Education: "metropolia", "Aalto University", "linkedin_learning", "inokufu udemy", "classcentral", "classcentral_ai", "any"
Jobs: "TMT", "Duunitori", "MOL", "Eures", "kuntarekry", "valtiolle", "any"
For jobs: MUST include "jobs" in request array.
Common: ["match","zpd","demand"] for courses. ["jobs"] for job matches.

## AFTER EVERY ANALYSIS

1. headai_run_analyst for automatic report:
   - Graphs: report_type 999 (Data Insight) or 15 (Strategic)
   - Scorecards: report_type 300 (Quick Opportunities)
   - Signals: report_type 400 (Signal Quick Opportunities)
2. For strategic deep dives: headai_run_composer (report_type 600) = full HTML report
3. Visualizer: https://cloud.headai.com/public/HeadaiVisualizer.html?json_url=GRAPH_URL

## PRESENTING RESULTS

Be conversational. The user came to understand something, not to read raw data.

1. Lead with the KEY finding in 1-2 sentences
2. Highlight the most surprising or interesting insight
3. Provide the visualizer link
4. Offer one logical next step as a question

**Explaining graphs to users (if they ask):**
- Nodes = concepts/skills. Edges = connections between them.
- Proximity = strength of relationship. Size = frequency/importance.
- Colors = theme clusters (same color = same topical group)
- Black lines between clusters = indirect connections through a shared concept
- Value = how strongly a concept appears. Weight = importance of a connection.
- "Think of the graph as a map for thinking — it shows how concepts connect and where to explore next."

## GUARDRAILS

- estimate_size is only for explicit data size questions — not needed before builds
- Two snapshots alone do not imply Scorecard — the user needs to ask for comparison
- Present results and suggest next steps rather than auto-chaining beyond the request
- Modify, Compass, and predict=true are opt-in based on user intent
- When unclear, ask one focused question
- For errors, direct users to info@headai.com — avoid mentioning specific employee names
- If a build call fails or drops, the job may already be queued server-side — avoid retrying, as duplicates waste API cores
- One heavy operation at a time (API has 2 cores per key)

## USE CASES BY SEGMENT

**Education:** Align curriculum with labour market. Identify skill gaps in study offerings. Detect emerging topics for course updates. Typical: Snapshot (curriculum) + Snapshot (job_ads) → Scorecard → report.
**Public sector:** Regional skills foresight. Workforce planning. Policy support. Typical: Snapshot by region → Signals for trends → report.
**Companies/HR:** Competency gap analysis. Recruitment planning. Upskilling roadmaps. Typical: Snapshot (internal) + Snapshot (market) → Scorecard → Compass for development paths.

## EXECUTION NOTES

- Heavy operations (BuildKnowledgeGraph, Signals, Scorecard) are async — "work in queue" and "work in calculation" are NORMAL, not errors
- Poll the result URL until status = "ready"
- If result is empty: check dataset/time filters, language mismatch, location fields
- If a build call returns an error or connection drops, the job is likely already queued on the server. Retrying creates a duplicate that wastes API cores. Wait and check if the first one completed.
- The API has only 2 cores per key. Two simultaneous heavy operations = both cores blocked. Always wait for one to finish before starting another.

## EXAMPLE ORCHESTRATIONS

**"I'm a nurse thinking about switching to tech"**
→ Career change. Ask: "Would you like to paste your CV, or should I map nursing skills from job data?" Then: profile → tech market snapshot → scorecard → compass for courses + jobs.

**"Turun meriteollisuuden osaamistarve"**
→ Snapshot intent (Finnish). headai_build_knowledge_graph(dataset:"job_ads", city:"Turku", 20 Finnish maritime industry keywords, size:500) → run_analyst(999) → present in Finnish.

**"How has demand for AI skills changed in the last 3 years?"**
→ Signals intent. 3 snapshots (2023, 2024, 2025) from job_ads → build_signals → run_analyst(400) → present emerging/declining groups.

**"Vertaa Metropolian ICT-koulutusta ja IT-työmarkkinoita"**
→ Compare intent (Finnish). Snapshot from curriculum (metropolia) + Snapshot from job_ads (IT) → Scorecard → run_analyst(300) → present gaps.

**"Mistä oppilaitoksista on dataa?"**
→ Explain intent. Answer directly: list Finnish institutions from knowledge above. Offer to analyze any of them.`
        }
      }
    ]
  })
);

server.prompt(
  "headai-cv-analysis",
  "Analyze a CV/resume: extract skills graph, compare to market demand, find gaps, recommend courses or jobs.",
  {
    cv_text: z.string().describe("The full text of the CV or resume to analyze"),
    target_role: z.string().optional().describe("Optional: job title or role the person is targeting"),
    language: z.string().optional().describe("Language code: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Analyze this CV using Headai tools:

1. headai_text_to_graph — parse the CV text below. language="${args.language || "en"}", legend="CV Analysis"
2. headai_run_analyst — report_type 999 on the CV graph to map skill clusters
3. ${args.target_role ? `headai_build_knowledge_graph — dataset "job_ads", 20 keywords for "${args.target_role}"
4. headai_scorecard — CV graph vs market graph
5. headai_run_analyst — report_type 300 on the scorecard (gap analysis)
6. headai_compass — namespace "any", request ["match","zpd","demand"] for courses, or ["jobs"] for job matches` : `headai_build_knowledge_graph — dataset "job_ads", 20 keywords matching the person's field
4. headai_scorecard — CV graph vs market graph
5. headai_run_analyst — report_type 300 on the scorecard
6. headai_compass — namespace "any", request ["match","zpd","demand"] for courses`}

Present: key strengths, skill gaps vs market, top recommendations. Include visualizer link.

## CV Text:
${args.cv_text}
${args.target_role ? `\n## Target Role: ${args.target_role}` : ""}`
        }
      }
    ]
  })
);

server.prompt(
  "headai-skill-gap-analysis",
  "Compare any two things (roles, curricula, companies, countries) to find skill gaps and overlaps.",
  {
    left_description: z.string().describe("First side to compare (e.g., 'Data Science curriculum at Aalto')"),
    right_description: z.string().describe("Second side (e.g., 'AI job market in Finland')"),
    language: z.string().optional().describe("Language code: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Skill gap analysis between two sides. Language: ${args.language || "en"}

**Left:** ${args.left_description}
**Right:** ${args.right_description}

1. For each side: if it's a dataset query (market, curriculum, research) → headai_build_knowledge_graph with 20 keywords. If it's raw text → headai_text_to_graph.
2. headai_scorecard — compare the two graphs
3. headai_run_analyst — report_type 300 (Quick Opportunities)

Present as: overlap (Group 1), left-only gaps (Group 2), right-only gaps (Group 3), match % (full_score_normalized), and actionable recommendations. Include visualizer link.`
        }
      }
    ]
  })
);

server.prompt(
  "headai-trend-analysis",
  "Detect what skills are emerging, growing, declining, or disappearing over time in any domain.",
  {
    topic: z.string().describe("Domain to analyze (e.g., 'artificial intelligence', 'renewable energy')"),
    years: z.string().optional().describe("Years to compare, comma-separated (default: '2023,2024,2025')"),
    dataset: z.string().optional().describe("Dataset: 'job_ads', 'doaj_articles', 'news' (default: 'job_ads')"),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => {
    const years = (args.years || "2023,2024,2025").split(",").map(y => y.trim());
    const dataset = args.dataset || "job_ads";
    const lang = args.language || "en";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Trend analysis for "${args.topic}". Dataset: ${dataset}, Years: ${years.join(", ")}, Language: ${lang}

1. Generate 20 domain-specific keywords for "${args.topic}" in ${dataset} vocabulary style
2. For each year (${years.join(", ")}): headai_build_knowledge_graph with search_year, size 500
3. headai_build_signals — all graph URLs in chronological order, predict=false, map_legends = year labels
4. headai_run_analyst — report_type 400 (Signal Quick Opportunities)

Present by signal group: Emerging (Group 1), Constantly Growing (2), Recently Growing (3), Stable (4), Recently Declining (7), Disappearing (8). Include visualizer link. Highlight the most surprising finding.`
          }
        }
      ]
    };
  }
);

server.prompt(
  "headai-job-search",
  "Find real job postings matching a query, with optional skill-based matching via Compass.",
  {
    query: z.string().describe("Job search query (e.g., 'data scientist', 'software engineer AI')"),
    country: z.string().optional().describe("Country code: 'fi', 'de', 'se', etc."),
    city: z.string().optional().describe("City name for more specific search")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Find jobs matching "${args.query}"${args.country ? ` in ${args.country}` : ""}${args.city ? `, ${args.city}` : ""}.

1. headai_get_jobs_by_text — text: "${args.query}"${args.country ? `, country: "${args.country}"` : ""}${args.city ? `, city: "${args.city}"` : ""}
2. Present: job titles, companies, locations, links
3. If user has a skills profile: headai_compass with namespace "any", request ["jobs"] for personalized matches
4. Summarize: common requirements, top employers, and suggest "Want me to analyze the skills needed for these roles?"`
        }
      }
    ]
  })
);

server.prompt(
  "headai-career-transition",
  "Guide someone through a career change: map current skills, explore target field, find gaps, recommend learning paths and matching jobs.",
  {
    current_role: z.string().describe("Current role or field (e.g., 'registered nurse', 'marketing manager')"),
    target_role: z.string().describe("Target role or field (e.g., 'UX designer', 'data analyst', 'tech')"),
    cv_text: z.string().optional().describe("Optional: paste CV text for precise skill mapping"),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Career transition analysis: ${args.current_role} → ${args.target_role}. Language: ${args.language || "en"}

## Phase 1: Map Current Skills
${args.cv_text ? `Use headai_text_to_graph on the CV text below.` : `Use headai_build_knowledge_graph — dataset "job_ads", 20 keywords for "${args.current_role}" roles. This creates a proxy skills profile.`}

## Phase 2: Map Target Field
headai_build_knowledge_graph — dataset "job_ads", 20 keywords for "${args.target_role}" roles, size 500

## Phase 3: Gap Analysis
headai_scorecard — compare current skills graph vs target field graph
headai_run_analyst — report_type 300 on the scorecard

## Phase 4: Recommendations
headai_compass — use the current skills graph, namespace "any", request ["match","zpd","demand"] for learning paths
headai_compass — namespace "any", request ["jobs"] for reachable job matches

## Present Results As:
1. "Transferable skills" — what you already have that the target field values (Group 1 from scorecard)
2. "Skills to develop" — gaps you need to close (Group 3 from scorecard)
3. "Your unique advantage" — skills from your background that are rare in the target field (Group 2)
4. "Recommended learning" — courses from Compass
5. "Jobs you could apply to now" — roles that match your current profile
6. Include visualizer links for both the scorecard and compass results
${args.cv_text ? `\n## CV Text:\n${args.cv_text}` : ""}`
        }
      }
    ]
  })
);

server.prompt(
  "headai-digital-twin",
  "Create, update, or retrieve a user's digital skills profile (Digital Twin) that persists across sessions.",
  {
    action: z.enum(["create", "retrieve", "share"]).describe("What to do: 'create' a new twin from text/graph, 'retrieve' an existing one, or 'share' via secure link"),
    user_name: z.string().optional().describe("Name to store the profile under"),
    skills_text: z.string().optional().describe("For 'create': paste CV, skills list, or free text describing the person's competencies"),
    twin_id: z.string().optional().describe("For 'retrieve' or 'share': the existing digital twin ID")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Digital Twin operation: ${args.action}

${args.action === "create" ? `## Create Digital Twin
1. headai_text_to_graph — parse the skills text below into a graph
2. headai_digital_twin — action "AddToTwin"${args.user_name ? `, name: "${args.user_name}"` : ""}. Pass the graph URL.
3. Confirm: "Your digital twin has been created. Twin ID: [id]. You can use this to retrieve your profile anytime."
${args.skills_text ? `\n## Skills Text:\n${args.skills_text}` : ""}` : ""}${args.action === "retrieve" ? `## Retrieve Digital Twin
1. headai_digital_twin — action "GetTwin", twin_id: "${args.twin_id || "[ask user for their twin ID]"}"
2. headai_describe_graph on the returned graph URL
3. Present the person's skill profile in a readable format
4. Suggest: "Want me to compare your profile to a job market, find courses, or check trends?"` : ""}${args.action === "share" ? `## Share Digital Twin
1. headai_digital_twin — action "GetSecureShareLink", twin_id: "${args.twin_id || "[ask user for their twin ID]"}"
2. Present the secure sharing link` : ""}`
        }
      }
    ]
  })
);

server.prompt(
  "headai-curriculum-analysis",
  "Analyze an education program or curriculum against job market demand to find alignment and gaps.",
  {
    program_description: z.string().describe("Name or description of the education program (e.g., 'Metropolia Software Engineering degree')"),
    market_domain: z.string().optional().describe("Target job market to compare against (e.g., 'software development in Finland'). If not specified, inferred from the program."),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Curriculum vs market analysis. Language: ${args.language || "en"}

**Program:** ${args.program_description}
**Market:** ${args.market_domain || "infer from the program's field"}

1. headai_build_knowledge_graph — dataset "curriculum", 20 keywords matching "${args.program_description}", size 500
   (If "curriculum" dataset doesn't cover this program, use headai_text_to_graph with program description)
2. headai_build_knowledge_graph — dataset "job_ads", 20 keywords for ${args.market_domain || "the program's target job market"}, size 500
3. headai_scorecard — curriculum graph vs market graph
4. headai_run_analyst — report_type 300

Present as:
- "Market-aligned skills" (Group 1) — what the program teaches that employers want
- "Program-unique content" (Group 2) — taught but not in high market demand (academic depth, foundational)
- "Market gaps" (Group 3) — what employers want but the program doesn't cover
- Match percentage and recommendations for curriculum improvement
- Include visualizer link`
        }
      }
    ]
  })
);

server.prompt(
  "headai-future-skills-radar",
  "Predict future skills for any domain by combining job market (now), investment data (1-3yr), and research (5-10yr) into one cross-horizon signals analysis.",
  {
    domain: z.string().describe("Domain to analyze (e.g., 'autonomous vehicles', 'healthcare AI', 'green energy')"),
    country: z.string().optional().describe("Country filter for job_ads (e.g., 'fi', 'de')"),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Future Skills Radar for "${args.domain}". Language: ${args.language || "en"}

This is a cross-horizon analysis combining three data sources to predict where skills are heading.

1. headai_build_knowledge_graph — dataset "job_ads"${args.country ? `, country: "${args.country}"` : ""}, 20 keywords for "${args.domain}" in LABOUR vocabulary (roles, tools, qualifications), size 500. Legend: "${args.domain} — Job Market Now"
2. headai_build_knowledge_graph — dataset "investment_data", 20 keywords for "${args.domain}" in BUSINESS vocabulary (sectors, technologies, markets), search_year: 2025, size 500. Legend: "${args.domain} — Investment 1-3yr"
3. headai_build_knowledge_graph — dataset "doaj_articles", 20 keywords for "${args.domain}" in RESEARCH vocabulary (theories, methods, constructs), language: "en", search_year: 2025, size 500. Legend: "${args.domain} — Research 5-10yr"
4. headai_build_signals — all 3 graph URLs in order (job_ads, investment, research), map_legends matching the legends above, predict=false
5. headai_run_analyst — report_type 400

Present as a "radar": what's needed NOW (from jobs), what's COMING SOON (from investments), and what's on the FAR HORIZON (from research). Skills appearing across all three layers are the strongest signals. Include visualizer link.`
        }
      }
    ]
  })
);

server.prompt(
  "headai-news-intelligence",
  "Quick briefing on what's happening RIGHT NOW in any topic, powered by real news data analysis.",
  {
    topic: z.string().describe("Topic to scan (e.g., 'AI regulation Europe', 'renewable energy Finland')"),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `News intelligence briefing for "${args.topic}". Language: ${args.language || "en"}

1. headai_build_knowledge_graph — dataset "news", 20 keywords for "${args.topic}", search_year: 2025, language: "${args.language || "en"}", size 500. Legend: "${args.topic} — News 2025"
2. headai_run_analyst — report_type 999 (Data Insight)

Present as a brief intelligence report: key themes, most connected concepts, and emerging narratives. Possible follow-ups: compare to last year (→ signals), or see what the job market says (→ job_ads snapshot + scorecard). Include visualizer link.`
        }
      }
    ]
  })
);

server.prompt(
  "headai-investment-signals",
  "Track where money is flowing in a sector and what skills that implies for the near future (1-3 years).",
  {
    sector: z.string().describe("Sector or domain (e.g., 'fintech', 'biotech', 'clean energy')"),
    compare_to_jobs: z.boolean().optional().describe("Also compare to current job market? (default: true)"),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Investment signals analysis for "${args.sector}". Language: ${args.language || "en"}

1. headai_build_knowledge_graph — dataset "investment_data", 20 keywords for "${args.sector}" in business/investment vocabulary, search_year: 2025, language: "${args.language || "en"}", size 500. Legend: "${args.sector} — Investment Signals"
2. headai_run_analyst — report_type 999
${args.compare_to_jobs !== false ? `3. headai_build_knowledge_graph — dataset "job_ads", 20 keywords for "${args.sector}" in labour vocabulary, size 500. Legend: "${args.sector} — Current Job Market"
4. headai_scorecard — compare investment graph vs job market graph
5. headai_run_analyst — report_type 300

Present: what investors are betting on, how that compares to current hiring, and where the GAP is (skills that investment signals predict will be needed but aren't yet in job postings — early movers can prepare for these).` : `Present: key investment themes, most connected areas, and what skills these investments will likely create demand for.`} Include visualizer link.`
        }
      }
    ]
  })
);

server.prompt(
  "headai-sdg-mapping",
  "Map any curriculum, organization, region, or text to the UN Sustainable Development Goals (SDGs) and find alignment gaps.",
  {
    subject: z.string().describe("What to map to SDGs (e.g., 'Metropolia ICT curriculum', 'Helsinki tech job market', or paste text)"),
    specific_sdgs: z.string().optional().describe("Specific SDG numbers to focus on, comma-separated (e.g., '4,8,9'). If not specified, maps against all SDGs."),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `SDG Alignment Analysis for: "${args.subject}". Language: ${args.language || "en"}

1. Build the subject graph:
   - If "${args.subject}" is a dataset query (job market, curriculum): headai_build_knowledge_graph with appropriate dataset and 20 keywords
   - If it's free text or a description: headai_text_to_graph

2. headai_scorecard — compare the subject graph against SDG ontology
   - Use scorecard with sdg_preset${args.specific_sdgs ? ` focused on SDGs ${args.specific_sdgs}` : ""}
   - The SDG ontology is built into Headai — you can reference it directly

3. headai_run_analyst — report_type 300

Present as SDG alignment report:
- Which SDGs the subject strongly aligns with (Group 1 — shared concepts)
- Which SDGs the subject contributes to uniquely (Group 2)
- Which SDG targets are NOT covered (Group 3 — alignment gaps)
- Match percentage per SDG where possible
- Recommendations for improving SDG alignment
Include visualizer link.`
        }
      }
    ]
  })
);

server.prompt(
  "headai-region-comparison",
  "Compare skills landscapes across cities, regions, or countries — find what makes each unique and where they overlap.",
  {
    regions: z.string().describe("Regions to compare, comma-separated (e.g., 'Helsinki, Tampere, Turku' or 'Finland, Sweden, Germany')"),
    domain: z.string().describe("Domain to compare (e.g., 'IT', 'healthcare', 'manufacturing')"),
    level: z.enum(["city", "country"]).optional().describe("Geographic level: 'city' or 'country' (default: 'city')"),
    language: z.string().optional().describe("Language: 'en' or 'fi' (default: 'en')")
  },
  (args) => {
    const regions = args.regions.split(",").map(r => r.trim());
    const level = args.level || "city";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Regional skills comparison: ${regions.join(" vs ")} in ${args.domain}. Language: ${args.language || "en"}

## Step 1: Build snapshots
For each region, headai_build_knowledge_graph — dataset "job_ads", ${level}: "<region>", 20 keywords for "${args.domain}" in labour vocabulary, size 500.
${regions.map((r, i) => `- Graph ${i + 1}: ${level}="${r}", legend="${r} — ${args.domain}"`).join("\n")}

## Step 2: Compare
${regions.length === 2 ? `headai_scorecard — compare the two graphs directly
headai_run_analyst — report_type 300` : `For ${regions.length} regions, compare pairwise or use headai_join_graphs to merge all into one combined view, then headai_run_analyst — report_type 999 for overview.
For deeper comparison, pick the two most interesting regions and headai_scorecard those.`}

## Present as:
- What each region specializes in (unique skills)
- Common skills across all regions
- Key differences and gaps
- Which region leads in what area
- Recommendations: "If you're in ${regions[0]} and want skills from ${regions[1]}, focus on..."
Include visualizer links for all graphs.`
          }
        }
      ]
    };
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
  <title>Headai MCP Server — Connect AI Agents to Headai Intelligence</title>
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
    <div class="endpoint"><span class="method">GET</span><code>/sse</code> — Legacy SSE transport (for Perplexity, older clients)</div>
    <div class="endpoint"><span class="method post">POST</span><code>/messages</code> — Legacy SSE message endpoint</div>
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
      <li><code>doaj_articles</code>, <code>investment_data</code>, <code>news</code>, <code>tiedejatutkimus</code> datasets require <code>search_year</code> parameter</li>
      <li>Use <code>headai_estimate_size</code> only when user asks about data size — otherwise build directly</li>
      <li>Verify search_text uses vocabulary matching the dataset type</li>
    </ul>
    <h3>Slow Responses</h3>
    <ul>
      <li>Large graphs (size &gt; 500) take longer to build</li>
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

  // Helper: parse URL-encoded form body (avoids importing express 4 on express 5 app)
  function parseUrlEncodedBody(req: any): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      // If body is already parsed (e.g. by express.json as a string), handle that
      if (req.body && typeof req.body === 'object') {
        resolve(req.body);
        return;
      }
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => {
        try {
          const params = new URLSearchParams(data);
          const result: Record<string, string> = {};
          params.forEach((value, key) => { result[key] = value; });
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  // Session management
  const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};
  const sessionApiKeys: Record<string, string> = {};

  // ── OAuth 2.0 In-Memory Stores ─────────────────────────────────────────────
  interface RegisteredClient {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
    client_name?: string;
  }

  interface AuthCode {
    code: string;
    client_id: string;
    api_key: string;
    code_challenge?: string;
    expires_at: number;
  }

  const registeredClients: Map<string, RegisteredClient> = new Map();
  const authCodes: Map<string, AuthCode> = new Map();
  const SERVER_BASE_URL = process.env.MCP_SERVER_BASE_URL || "https://mcp.headai.dev";
  const CLAUDE_AI_CALLBACK_URLS = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
  ];

  // ── OAuth 2.0 Endpoints ─────────────────────────────────────────────────────

  /**
   * GET /.well-known/oauth-authorization-server
   * Returns OAuth metadata for MCP client discovery
   */
  app.get("/.well-known/oauth-authorization-server", (_req: any, res: any) => {
    res.json({
      issuer: SERVER_BASE_URL,
      authorization_endpoint: `${SERVER_BASE_URL}/oauth/authorize`,
      token_endpoint: `${SERVER_BASE_URL}/oauth/token`,
      registration_endpoint: `${SERVER_BASE_URL}/oauth/register`,
      scopes_supported: ["profile"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256", "plain"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["none"],
    });
  });

  /**
   * POST /oauth/register
   * Dynamic Client Registration (RFC 7591)
   * Claude.ai registers itself as a client
   */
  app.post("/oauth/register", (req: any, res: any) => {
    const clientName = req.body.client_name || "MCP Client";
    const redirectUris = req.body.redirect_uris as string[] | undefined;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "redirect_uris is required and must be non-empty",
      });
      return;
    }

    const clientId = randomUUID();
    const clientSecret = randomUUID();

    const client: RegisteredClient = {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      client_name: clientName,
    };

    registeredClients.set(clientId, client);

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      redirect_uris: redirectUris,
      response_types: ["code"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "client_secret_basic",
      code_challenge_methods: ["S256"],
    });
  });

  /**
   * GET /oauth/authorize
   * Shows HTML form for user to enter their Headai API key
   */
  app.get("/oauth/authorize", (req: any, res: any) => {
    const clientId = req.query.client_id as string | undefined;
    const redirectUri = req.query.redirect_uri as string | undefined;
    const state = req.query.state as string | undefined;
    const codeChallenge = req.query.code_challenge as string | undefined;
    const codeChallengeMethod = req.query.code_challenge_method as string | undefined;

    const client = clientId ? registeredClients.get(clientId) : undefined;
    const isPreview = !clientId;

    if (clientId && !client) {
      res.status(400).json({ error: "invalid_client", error_description: "Unknown client_id" });
      return;
    }

    if (!isPreview && (!redirectUri || !client!.redirect_uris.includes(redirectUri))) {
      res.status(400).json({ error: "invalid_request", error_description: "Mismatched redirect_uri" });
      return;
    }

    // Render authorization form — Headai branded
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Headai — Authorize</title>
        <link rel="icon" href="https://headai.com/favicon.ico">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }

          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f0f4f8;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }

          .card {
            background: white;
            border-radius: 16px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
            max-width: 440px;
            width: 100%;
            overflow: hidden;
          }

          .header {
            background: linear-gradient(135deg, #00A7E1 0%, #0066CC 100%);
            padding: 32px 40px 28px;
            text-align: center;
          }

          .header img {
            height: 48px;
            margin-bottom: 12px;
          }

          .header h1 {
            font-size: 20px;
            font-weight: 600;
            color: white;
            letter-spacing: -0.3px;
          }

          .header p {
            color: rgba(255,255,255,0.85);
            font-size: 13px;
            margin-top: 6px;
          }

          .body {
            padding: 32px 40px 36px;
          }

          .client-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: #EBF5FF;
            color: #0066CC;
            font-size: 12px;
            font-weight: 500;
            padding: 6px 12px;
            border-radius: 20px;
            margin-bottom: 24px;
          }

          .client-badge svg {
            width: 14px; height: 14px;
          }

          .form-group { margin-bottom: 20px; }

          label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: #1a202c;
            margin-bottom: 6px;
          }

          input[type="password"],
          input[type="text"] {
            width: 100%;
            padding: 11px 14px;
            border: 1.5px solid #d1d9e0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.2s, box-shadow 0.2s;
            background: #fafbfc;
          }

          input:focus {
            outline: none;
            border-color: #00A7E1;
            box-shadow: 0 0 0 3px rgba(0, 167, 225, 0.12);
            background: white;
          }

          .help-text {
            font-size: 12px;
            color: #6b7280;
            margin-top: 6px;
            line-height: 1.4;
          }

          .button-group {
            display: flex;
            gap: 10px;
            margin-top: 28px;
          }

          button {
            flex: 1;
            padding: 11px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
          }

          .btn-authorize {
            background: linear-gradient(135deg, #00A7E1 0%, #0066CC 100%);
            color: white;
          }

          .btn-authorize:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 16px rgba(0, 102, 204, 0.35);
          }

          .btn-cancel {
            background: #f3f4f6;
            color: #4b5563;
          }

          .btn-cancel:hover {
            background: #e5e7eb;
          }

          .footer {
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid #e5e7eb;
            font-size: 11px;
            color: #9ca3af;
            text-align: center;
            line-height: 1.6;
          }

          .footer a {
            color: #0066CC;
            text-decoration: none;
          }

          .footer a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <img src="data:image/png;base64,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"
                 alt="Headai" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
            <div style="display:none;font-size:32px;font-weight:700;color:white;letter-spacing:-1px;">headai</div>
            <h1>Authorize Connection</h1>
            <p>Grant access to Headai Intelligence</p>
          </div>

          <div class="body">
            <div class="client-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Connecting via MCP
            </div>

            ${isPreview ? `
              <div style="text-align:center;padding:24px 0 8px;">
                <div style="font-size:15px;color:#64748b;line-height:1.6;">
                  This is the OAuth authorization page for the<br>
                  <strong style="color:#334155;">Headai MCP Server</strong>.<br><br>
                  When connecting from an AI client (Claude, ChatGPT, Copilot&nbsp;Studio, etc.),<br>
                  this page will prompt you to enter your Headai API key.
                </div>
                <a href="https://headai.com" target="_blank"
                   style="display:inline-block;margin-top:20px;padding:10px 28px;background:#00A7E1;color:white;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
                  Learn more at headai.com
                </a>
              </div>
            ` : `
              <form method="POST" action="/oauth/authorize">
                <div class="form-group">
                  <label for="api_key">Headai API Key</label>
                  <input
                    type="password"
                    id="api_key"
                    name="api_key"
                    placeholder="Enter your API key"
                    required
                    autocomplete="off"
                  />
                  <div class="help-text">Your key is used only to authenticate API calls. It is not stored or logged.</div>
                </div>

                <input type="hidden" name="client_id" value="${clientId}">
                <input type="hidden" name="redirect_uri" value="${redirectUri}">
                <input type="hidden" name="state" value="${state || ''}">
                <input type="hidden" name="code_challenge" value="${codeChallenge || ''}">
                <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod || ''}">

                <div class="button-group">
                  <button type="button" class="btn-cancel" onclick="cancelAuth()">Cancel</button>
                  <button type="submit" class="btn-authorize">Authorize</button>
                </div>
              </form>
            `}

            <div class="footer">
              Powered by <a href="https://headai.com" target="_blank">headai.com</a><br>
              <a href="https://headai.com/privacy-policy" target="_blank">Privacy</a> &nbsp;&bull;&nbsp;
              <a href="https://www.headai.com/end-user-license-agreement/" target="_blank">EULA</a>
            </div>
          </div>
        </div>

        <script>
          function cancelAuth() {
            const state = "${state || ''}";
            const redirectUri = "${redirectUri}";
            if (state) {
              window.location = redirectUri + "?error=access_denied&state=" + encodeURIComponent(state);
            } else {
              window.location = redirectUri + "?error=access_denied";
            }
          }
        </script>
      </body>
      </html>
    `;

    res.type("html").send(html);
  });

  /**
   * POST /oauth/authorize
   * Processes form submission, generates auth code, redirects to callback
   */
  app.post("/oauth/authorize", async (req: any, res: any) => {
    const body = await parseUrlEncodedBody(req);
    const clientId = body.client_id as string | undefined;
    const redirectUri = body.redirect_uri as string | undefined;
    const state = body.state as string | undefined;
    const apiKey = body.api_key as string | undefined;
    const codeChallenge = body.code_challenge as string | undefined;
    const codeChallengeMethod = body.code_challenge_method as string | undefined;

    if (!clientId || !redirectUri || !apiKey) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const client = registeredClients.get(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      res.status(400).json({ error: "invalid_request", error_description: "Mismatched client or redirect_uri" });
      return;
    }

    // Generate authorization code
    const code = randomUUID();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    authCodes.set(code, {
      code,
      client_id: clientId,
      api_key: apiKey,
      code_challenge: codeChallenge,
      expires_at: expiresAt,
    });

    // Redirect back to Claude.ai with authorization code
    const params = new URLSearchParams({
      code,
      state: state || "",
    });

    const callbackUrl = `${redirectUri}?${params.toString()}`;
    res.redirect(callbackUrl);
  });

  /**
   * POST /oauth/token
   * Exchanges authorization code for access token (which is the API key)
   */
  app.post("/oauth/token", async (req: any, res: any) => {
    const body = await parseUrlEncodedBody(req);
    const grantType = body.grant_type as string | undefined;
    const code = body.code as string | undefined;
    const codeVerifier = body.code_verifier as string | undefined;
    const redirectUri = body.redirect_uri as string | undefined;
    const clientId = body.client_id as string | undefined;
    const clientSecret = body.client_secret as string | undefined;

    // Extract Basic auth if present
    const authHeader = req.headers["authorization"] as string | undefined;
    let authClientId = clientId;
    let authClientSecret = clientSecret;

    if (authHeader && authHeader.toLowerCase().startsWith("basic ")) {
      const credentials = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      const [id, secret] = credentials.split(":");
      authClientId = id;
      authClientSecret = secret;
    }

    if (grantType !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    if (!code || !authClientId || !authClientSecret) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    // Verify client credentials
    const client = registeredClients.get(authClientId);
    if (!client || client.client_secret !== authClientSecret) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    // Look up auth code
    const authCode = authCodes.get(code);
    if (!authCode || authCode.client_id !== authClientId || Date.now() > authCode.expires_at) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // Verify PKCE if code_challenge was used
    if (authCode.code_challenge && codeVerifier) {
      const crypto = await import("node:crypto");
      const hash = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");

      if (hash !== authCode.code_challenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    // Clean up used auth code
    authCodes.delete(code);

    // Return access token (which is the API key)
    res.json({
      access_token: authCode.api_key,
      token_type: "Bearer",
      expires_in: 31536000, // 1 year
      scope: "profile",
    });
  });

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
    return ""; // No auth header → require OAuth or Bearer token
  }

  // Health check
  app.get("/health", (_req: any, res: any) => {
    res.json({
      status: "ok",
      server: "headai-mcp-server",
      version: "1.1.0-oauth",
      tools: 23,
      transport: "streamable-http",
      oauth: true,
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
            "6 datasets: job_ads, doaj_articles, curriculum, investment_data, news, tiedejatutkimus",
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
        const existing = transports[sessionId];
        if (!(existing instanceof StreamableHTTPServerTransport)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Session uses a different transport protocol" },
            id: null,
          });
          return;
        }
        transport = existing;
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

  // MCP GET endpoint (Streamable HTTP SSE streams)
  app.get("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const existing = transports[sessionId];
    if (existing instanceof StreamableHTTPServerTransport) {
      await existing.handleRequest(req, res);
    } else {
      res.status(400).send("Session uses a different transport protocol");
    }
  });

  // MCP DELETE endpoint (session termination)
  app.delete("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const existing = transports[sessionId];
    if (existing instanceof StreamableHTTPServerTransport) {
      await existing.handleRequest(req, res);
    } else {
      res.status(400).send("Session uses a different transport protocol");
    }
  });

  // ── Legacy SSE Transport (for Perplexity, older clients) ──────────────────
  // GET /sse → establishes SSE stream
  // POST /messages?sessionId=xxx → sends messages to the server

  app.get("/sse", async (req: any, res: any) => {
    console.log("SSE connection request from:", req.headers["user-agent"]?.slice(0, 60));

    // Extract API key from Bearer token or query param
    const callerApiKey = extractApiKey(req) || (req.query.api_key as string);
    if (!callerApiKey) {
      res.status(401).send("Unauthorized: Provide your Headai API key as Authorization: Bearer <your_key>");
      return;
    }

    const transport = new SSEServerTransport("/messages", res);
    const sid = transport.sessionId;
    transports[sid] = transport;
    sessionApiKeys[sid] = callerApiKey;

    console.log(`SSE session initialized: ${sid} (key: ${callerApiKey.slice(0, 4)}...)`);

    res.on("close", () => {
      console.log(`SSE session closed: ${sid}`);
      delete transports[sid];
      delete sessionApiKeys[sid];
    });

    const sessionServer = createServer(callerApiKey);
    await sessionServer.connect(transport);
  });

  app.post("/messages", async (req: any, res: any) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).send("Missing sessionId query parameter");
      return;
    }

    const existing = transports[sessionId];
    if (!existing || !(existing instanceof SSEServerTransport)) {
      res.status(400).send("No SSE transport found for sessionId");
      return;
    }

    await existing.handlePostMessage(req, res, req.body);
  });

  app.listen(HTTP_PORT, HTTP_HOST, () => {
    console.log(`Headai MCP server listening on ${HTTP_HOST}:${HTTP_PORT}`);
    console.log(`  Health:         http://${HTTP_HOST}:${HTTP_PORT}/health`);
    console.log(`  Streamable HTTP: http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
    console.log(`  Legacy SSE:     http://${HTTP_HOST}:${HTTP_PORT}/sse`);
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
