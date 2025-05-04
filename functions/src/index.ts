/* eslint-disable */
// index.ts
// Versão COMPLETA FINAL com ferramentas RapidAPI, Scrapers, Notícias HLTV,
// Comandos Rápidos e Prompt Refinado v2 (temp 0.5).

import * as dotenv from "dotenv";
import express from "express";
import type {ZodIssue} from "zod";
import * as z from "zod";

// --- Imports Genkit ---
import {genkit, MessageData} from "genkit";
import {gemini15Flash, googleAI} from "@genkit-ai/googleai";
import {defineFlow, runFlow} from "@genkit-ai/flow";

// --- Imports das Ferramentas e Outros ---
import HLTV from "hltv";
import wiki from "wikipedia";
import * as path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import Redis from "ioredis";
import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser"; // <--- Importar RSS Parser

// --- Carregamento de Variáveis de Ambiente ---
dotenv.config({path: path.resolve(__dirname, "../.env")});
console.log("--- DEBUG ENV VARS ---");
console.log("RAPIDAPI_KEY:", process.env.RAPIDAPI_KEY ? "Presente" : "AUSENTE! API de partidas pode não funcionar.");
console.log("--- END DEBUG ---");

// --- Configuração do Cliente Redis ---
const redisUrl = process.env.REDIS_URL;
let redis: Redis | null = null;
if (redisUrl) {
  try {
    redis = new Redis(redisUrl);
    console.info("Conexão Redis OK.");
    redis.on("error", (err) => console.error("Erro Redis:", err));
  } catch (err) {
    console.error("Falha Redis init:", err);
  }
} else {
  console.warn("REDIS_URL não definida.");
}


// --- Configuração do Bot Telegram ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const contactInfo = process.env.CONTACT_EMAIL || "fallback-email@example.com";
if (!telegramToken) {
  console.error("Erro: TELEGRAM_BOT_TOKEN não definido!");
  throw new Error("Token Telegram não configurado.");
}
if (contactInfo === "fallback-email@example.com") {
  console.warn("AVISO: Variável de ambiente CONTACT_EMAIL não definida.");
}
console.info("Token Telegram OK.");
const bot = new TelegramBot(telegramToken);
console.info("Instância Bot Telegram OK.");


// --- Inicialização do Genkit ---
console.info("Inicializando Genkit com plugin googleAI...");
const ai = genkit({plugins: [googleAI()]});
console.info("Instância Genkit 'ai' criada.");

// --- Constantes ---
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "esportapi1.p.rapidapi.com";
const FURIA_TEAM_ID = "364252";
const LIQUIPEDIA_API_URL = "https://liquipedia.net/counterstrike/api.php";
const LIQUIPEDIA_PAGE_NAME_MAIN = "FURIA";
const LIQUIPEDIA_PAGE_NAME_MATCHES = "FURIA/Matches";
const HLTV_RSS_NEWS_URL = "https://www.hltv.org/rss/news";
const CUSTOM_USER_AGENT = `FuriaChatChallengeBot/1.0 (${contactInfo})`;
const NEWS_FILTER_TERMS = ["furia", "yuurih", "kscerato", "fallen", "molodoy", "yekindar", "sidde", "guerri"]; // Lowercase

// --- Definição das Ferramentas ---

// --- Ferramenta Roster (HLTV/Liquipedia Fallback) ---
export enum TeamPlayerType {
  Coach = "Coach",
  Starter = "Starter",
  Substitute = "Substitute",
  Benched = "Benched"
}

const rosterCacheSchema = z.object({
  playersInfo: z.string().optional(),
  error: z.string().optional(),
  source: z.enum(["hltv", "liquipedia", "cache-hltv", "cache-liquipedia"]).optional(),
});
const furiaRosterOutputSchema = z.object({
  playersInfo: z.string().optional().describe("String formatada com nome e tipo dos jogadores. Ex: 'yuurih, KSCERATO, FalleN (Captain), molodoy, YEKINDAR (Stand-in), sidde (Coach)'"),
  error: z.string().optional().describe("Mensagem de erro se a busca falhar."),
  source: z.enum(["HLTV", "Liquipedia"]).optional().describe("Fonte da informação."),
});

async function executeGetFuriaRoster(): Promise<z.infer<typeof furiaRosterOutputSchema>> {
  console.info("[Tool Exec] getFuriaRoster chamada (HLTV com fallback Liquipedia API).");
  const hltvCacheKey = "hltv:furia_roster_v3";
  const liquipediaCacheKey = "liquipedia:furia_roster_v3";
  const CACHE_TTL_SUCCESS = 14400;
  const CACHE_TTL_ERROR = 3600;
  let hltvResult: z.infer<typeof rosterCacheSchema> | null = null;
  let isCloudflareBlock = false;

  // 1a. Checar Cache HLTV
  if (redis) {
    try {
      const cachedData = await redis.get(hltvCacheKey);
      if (cachedData) {
        try {
          const parsedCache = rosterCacheSchema.parse(JSON.parse(cachedData));
          if (parsedCache && !parsedCache.error) {
            console.info(`[Cache HLTV] hit ${hltvCacheKey}`);
            return {
              playersInfo: parsedCache.playersInfo,
              source: "HLTV",
            };
          } else if (parsedCache?.error) {
            console.warn(`[Cache HLTV] hit com erro ${hltvCacheKey}: ${parsedCache.error}`);
            if (parsedCache.error.includes("Cloudflare") || parsedCache.error.includes("Access denied") || parsedCache.error.includes("bloqueio")) {
              isCloudflareBlock = true;
            }
          }
        } catch (parseErr) {
          console.warn(`[Cache HLTV] Erro ao parsear ${hltvCacheKey}:`, parseErr);
        }
      } else {
        console.info(`[Cache HLTV] miss ${hltvCacheKey}`);
      }
    } catch (e) {
      console.error(`[Cache HLTV] erro read ${hltvCacheKey}`, e);
    }
  }

  // 1b. Tentar API HLTV
  if (!isCloudflareBlock) {
    console.info("[HLTV API] Tentando buscar dados...");
    try {
      const team = await HLTV.getTeam({id: 8297});
      if (!team?.players?.length) throw new Error("Dados HLTV não encontrados.");
      const players = team.players.map(p => p.name ? `${p.name}${p.type === TeamPlayerType.Coach ? " (Coach)" : ""}` : null).filter((p): p is string => p !== null);
      if (players.length === 0) throw new Error("Jogadores HLTV não encontrados.");
      const playersInfo = players.join(", ");
      console.info(`[HLTV API] Sucesso: ${playersInfo}`);
      hltvResult = {playersInfo: playersInfo, source: "hltv"};
      if (redis) {
        try {
          await redis.set(hltvCacheKey, JSON.stringify(hltvResult), "EX", CACHE_TTL_SUCCESS);
          console.info(`[Cache HLTV] saved ok ${hltvCacheKey}`);
        } catch (e) {
          console.error(`[Cache HLTV] save err ${hltvCacheKey}`, e);
        }
      }
      return {playersInfo: hltvResult.playersInfo, source: "HLTV"};
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[HLTV API] Erro:", errorMsg);
      isCloudflareBlock = errorMsg.includes("Cloudflare") || errorMsg.includes("Access denied");
      const errorToCache = `Falha HLTV: ${isCloudflareBlock ? "Bloqueio Cloudflare." : errorMsg}`;
      hltvResult = {error: errorToCache, source: "hltv"};
      if (redis) {
        try {
          await redis.set(hltvCacheKey, JSON.stringify(hltvResult), "EX", CACHE_TTL_ERROR);
          console.info(`[Cache HLTV] saved err ${hltvCacheKey}`);
        } catch (e) {
          console.error(`[Cache HLTV] save err ${hltvCacheKey}`, e);
        }
      }
      if (!isCloudflareBlock) console.warn("[HLTV API] Falha não-CF, tentando Liquipedia...");
    }
  } else {
    console.warn("[HLTV] Bloqueio CF detectado/cacheado, pulando para Liquipedia.");
  }

  // 2. Tentar Liquipedia API como Fallback
  console.info("[Liquipedia Fallback] Tentando buscar (Roster)...");
  let liquipediaResult: z.infer<typeof rosterCacheSchema> | null = null;
  if (redis) {
    try {
      const d = await redis.get(liquipediaCacheKey);
      if (d) {
        try {
          const p = rosterCacheSchema.parse(JSON.parse(d));
          if (!p.error) {
            console.info(`[Cache Liquipedia] hit ${liquipediaCacheKey}`);
            return {
              playersInfo: p.playersInfo,
              source: "Liquipedia",
            };
          } else {
            console.warn(`[Cache Liquipedia] hit erro ${liquipediaCacheKey}`);
          }
        } catch (pE) {
          console.warn(`[Cache Liquipedia] parse err ${liquipediaCacheKey}`, pE);
        }
      } else {
        console.info(`[Cache Liquipedia] miss ${liquipediaCacheKey}`);
      }
    } catch (e) {
      console.error(`[Cache Liquipedia] read err ${liquipediaCacheKey}`, e);
    }
  }

  try {
    console.info(`[Liquipedia API] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MAIN}...`);
    const response = await axios.get(LIQUIPEDIA_API_URL, {
      params: {
        action: "parse",
        page: LIQUIPEDIA_PAGE_NAME_MAIN,
        prop: "text",
        format: "json",
        disabletoc: true,
      }, headers: {"User-Agent": CUSTOM_USER_AGENT}, timeout: 20000,
    });
    if (response.data?.error) throw new Error(`API Liquipedia erro: ${response.data.error.info}`);
    const htmlContent = response.data?.parse?.text?.["*"];
    if (!htmlContent) throw new Error("HTML Liquipedia não encontrado.");
    const $ = cheerio.load(htmlContent);
    const players: string[] = [];
    const activeHeader = $("h3 > span#Active");
    if (activeHeader.length === 0) throw new Error("Header 'Active' não encontrado.");
    const rosterTableWrapper = activeHeader.closest("h3").nextAll("div.table-responsive.roster-card-wrapper").first();
    const rosterTable = rosterTableWrapper.find("table.wikitable.roster-card").first();
    if (rosterTable.length === 0) throw new Error("Tabela roster-card não encontrada.");
    console.info("[Liquipedia Parser] Tabela 'Active' encontrada, processando...");
    rosterTable.find("tbody tr.Player").each((_i, r) => {
      const link = $(r).find("td.ID a").first();
      let name = link.attr("title");
      if (!name || name.includes("does not exist")) {
        name = link.text().trim();
      }
      if (name) {
        const role = $(r).find("td.Position i").text().trim();
        players.push(role ? `${name.trim()} ${role}` : name.trim());
      }
    });
    if (players.length > 0) {
      const info = players.join(", ");
      console.info("[Liquipedia API] Sucesso (Roster):", info);
      liquipediaResult = {playersInfo: info, source: "liquipedia"};
    } else {
      throw new Error("Extração tabela 'Active' vazia.");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Liquipedia API] Erro (Roster):", msg);
    liquipediaResult = {
      error: `Falha Liquipedia (Roster): ${msg}`,
      source: "liquipedia",
    };
  }

  if (redis && liquipediaResult) {
    try {
      const ttl = liquipediaResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
      await redis.set(liquipediaCacheKey, JSON.stringify(liquipediaResult), "EX", ttl);
      console.info(`[Cache Liquipedia] saved ${liquipediaCacheKey}`);
    } catch (e) {
      console.error(`[Cache Liquipedia] save err ${liquipediaCacheKey}`, e);
    }
  }

  if (liquipediaResult && !liquipediaResult.error) {
    return {
      playersInfo: liquipediaResult.playersInfo,
      source: "Liquipedia",
    };
  } else {
    const hltvE = isCloudflareBlock ? "Bloqueio Cloudflare" : (hltvResult?.error || "?");
    const liqE = liquipediaResult?.error || "?";
    const finalE = `Falha Roster. HLTV:${hltvE}. Liquipedia:${liqE}.`;
    console.error("[Tool Exec] Falha fontes (Roster):", finalE);
    return {error: finalE};
  }
}

const getFuriaRosterTool = ai.defineTool({
  name: "getFuriaRoster",
  description: "Busca a escalação ATUAL da FURIA CS2 (HLTV/Liquipedia). SEMPRE use esta ferramenta para perguntas sobre o elenco.",
  inputSchema: z.object({}),
  outputSchema: furiaRosterOutputSchema,
}, executeGetFuriaRoster);

// --- Ferramenta Wikipedia ---
const wikipediaSearchSchema = z.object({searchTerm: z.string().describe("Termo a pesquisar na Wikipedia")});
const wikipediaOutputSchema = z.object({
  summary: z.string().optional(),
  error: z.string().optional(),
  source: z.literal("cache").or(z.literal("api")).optional(),
});

async function executeSearchWikipedia(input: z.infer<typeof wikipediaSearchSchema>): Promise<z.infer<typeof wikipediaOutputSchema>> {
  const searchTerm = input.searchTerm;
  console.info(`[Tool Exec] searchWikipedia buscando '${searchTerm}'.`);
  const cacheKey = `wiki:${searchTerm.toLowerCase().replace(/\s+/g, "_")}`;
  const CACHE_TTL_SUCCESS = 86400;
  const CACHE_TTL_ERROR = 3600;
  if (redis) {
    try {
      const d = await redis.get(cacheKey);
      if (d) {
        try {
          const p = JSON.parse(d);
          const v = wikipediaOutputSchema.safeParse(p);
          if (v.success) {
            if (v.data.summary) {
              console.info(`[Cache Wiki] hit ${searchTerm}`);
              return {...v.data, source: "cache"};
            }
            if (v.data.error) console.warn(`[Cache Wiki] Erro cacheado ${searchTerm}`);
          } else {
            console.warn(`[Cache Wiki] Dados inválidos ${searchTerm}`);
          }
        } catch (pE) {
          console.warn(`[Cache Wiki] parse err ${searchTerm}`, pE);
        }
      } else {
        console.info(`[Cache Wiki] miss ${searchTerm}`);
      }
    } catch (e) {
      console.error(`[Cache Wiki] read err ${searchTerm}`, e);
    }
  }
  let apiResult: z.infer<typeof wikipediaOutputSchema>;
  try {
    wiki.setLang("pt");
    const page = await wiki.page(searchTerm, {autoSuggest: true});
    if (!page) {
      console.warn(`[Wiki API] Página '${searchTerm}' não encontrada.`);
      apiResult = {error: `Página '${searchTerm}' não encontrada na Wikipedia.`};
    } else {
      const summaryResult = await page.summary();
      if (!summaryResult?.extract) {
        console.warn(`[Wiki API] Resumo vazio ${searchTerm}.`);
        apiResult = {error: `Não foi possível obter um resumo para '${searchTerm}'.`};
      } else {
        const MAX = 1500;
        let txt = summaryResult.extract;
        if (txt.length > MAX) {
          txt = txt.substring(0, MAX) + "... (truncado)";
          console.info(`[Wiki API] Resumo truncado ${searchTerm}.`);
        }
        apiResult = {summary: txt, source: "api"};
        console.info(`[Wiki API] Resumo ok ${searchTerm}.`);
      }
    }
  } catch (err) {
    console.error(`[Wiki API] Erro ${searchTerm}:`, err);
    const msg = err instanceof Error ? err.message : "?";
    let eMsg = `Erro Wiki: ${msg}`;
    if (String(err).includes("No article") || String(err).includes("does not match")) {
      eMsg = `Artigo '${searchTerm}' não encontrado na Wikipedia.`;
    }
    apiResult = {error: eMsg};
  }
  if (redis) {
    try {
      const ttl = apiResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
      await redis.set(cacheKey, JSON.stringify(apiResult), "EX", ttl);
      console.info(`[Cache Wiki] saved ${searchTerm}`);
    } catch (e) {
      console.error(`[Cache Wiki] save err ${searchTerm}`, e);
    }
  }
  return apiResult;
}

const searchWikipediaTool = ai.defineTool({
  name: "searchWikipedia",
  description: "Busca um resumo na Wikipedia (jogador, time, evento). Use SEMPRE para perguntas sobre pessoas específicas.",
  inputSchema: wikipediaSearchSchema,
  outputSchema: wikipediaOutputSchema,
}, executeSearchWikipedia);

// --- Ferramenta Próximas Partidas (RapidAPI) ---
const upcomingMatchesRapidAPIOutputSchema = z.object({
  matchesInfo: z.string().optional().describe("String com próximas partidas da API. Ex: 'vs NAVI (ESL Pro League) - 10/05/2025 14:00 (BRT); ...' ou msg de 'não encontrado'."),
  error: z.string().optional(),
});

async function executeGetFuriaUpcomingMatchesRapidAPI(): Promise<z.infer<typeof upcomingMatchesRapidAPIOutputSchema>> {
  console.info("[Tool Exec] getFuriaUpcomingMatchesRapidAPI chamada.");
  const cacheKey = "rapidapi:furia_upcoming_v1";
  const CACHE_TTL_SUCCESS = 7200;
  const CACHE_TTL_ERROR = 1800;
  if (!RAPIDAPI_KEY) return {error: "Chave da API (RapidAPI) não configurada."};
  if (redis) {
    try {
      const d = await redis.get(cacheKey);
      if (d) {
        console.info(`[Cache RapidAPI Upcoming] hit ${cacheKey}`);
        return JSON.parse(d);
      } else {
        console.info(`[Cache RapidAPI Upcoming] miss ${cacheKey}`);
      }
    } catch (e) {
      console.error(`[Cache RapidAPI Upcoming] Read Error ${cacheKey}:`, e);
    }
  }
  const options = {
    method: "GET",
    url: `https://${RAPIDAPI_HOST}/api/esport/team/${FURIA_TEAM_ID}/matches/next/3`,
    headers: {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_HOST,
    },
    timeout: 15000,
  };
  let result: z.infer<typeof upcomingMatchesRapidAPIOutputSchema>;
  try {
    const response = await axios.request(options);
    const data = response.data;
    const events = data?.events ?? (Array.isArray(data) ? data : []);
    if (!Array.isArray(events) || events.length === 0) {
      console.info("[RapidAPI] Nenhuma partida futura encontrada.");
      result = {matchesInfo: "Nenhuma partida futura encontrada (API)."};
    } else {
      const matches = events.map((match: any) => {
        const opponent = match.awayTeam?.id?.toString() === FURIA_TEAM_ID ? match.homeTeam?.name : match.awayTeam?.name ?? "?";
        const tournament = match.tournament?.name ?? "?";
        const timestamp = match.startTimestamp;
        let formattedDate = "?";
        if (timestamp) {
          try {
            formattedDate = new Date(timestamp * 1000).toLocaleString("pt-BR", {
              timeZone: "America/Sao_Paulo",
              dateStyle: "short",
              timeStyle: "short",
            }) + " (BRT)";
          } catch (e) {
          }
        }
        return `vs ${opponent} (${tournament}) - ${formattedDate}`;
      }).filter(m => !m.includes("?"));
      result = {matchesInfo: matches.length > 0 ? matches.join("; ") : "Nenhuma partida futura com dados completos encontrada (API)."};
    }
    console.info("[RapidAPI] Sucesso (Upcoming):", result.matchesInfo);
  } catch (error: any) {
    console.error("[RapidAPI] Erro Upcoming:", error.response?.status, error.message);
    let errorMsg = `Falha API Upcoming (${error.code || error.response?.status || "?"}).`;
    if (error.response?.status === 429) errorMsg = "Limite API atingido."; else if (error.response?.status === 403) errorMsg = "Acesso negado API."; else if (error.code === "ECONNABORTED") errorMsg = "Timeout API.";
    result = {error: errorMsg};
  }
  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
      await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);
      console.info(`[Cache RapidAPI Upcoming] saved ${cacheKey}`);
    } catch (e) {
      console.error(`[Cache RapidAPI Upcoming] Save Err ${cacheKey}:`, e);
    }
  }
  return result;
}

const getFuriaUpcomingMatchesRapidAPITool = ai.defineTool({
  name: "getFuriaUpcomingMatchesRapidAPI",
  description: "Busca as próximas 3 partidas da FURIA CS2 (Fonte: API Externa). Use esta ferramenta PRIMEIRO para próximos jogos.",
  inputSchema: z.object({}),
  outputSchema: upcomingMatchesRapidAPIOutputSchema,
}, executeGetFuriaUpcomingMatchesRapidAPI);

// --- Ferramenta Resultados Recentes (RapidAPI) ---
const recentResultsRapidAPIOutputSchema = z.object({
  resultsInfo: z.string().optional().describe("String com resultados recentes da API. Ex: 'vs NAVI (L 0-2) (ESL Pro League); ...' ou msg de 'não encontrado'."),
  error: z.string().optional(),
});

async function executeGetFuriaRecentResultsRapidAPI(): Promise<z.infer<typeof recentResultsRapidAPIOutputSchema>> {
  console.info("[Tool Exec] getFuriaRecentResultsRapidAPI chamada.");
  const cacheKey = "rapidapi:furia_recent_v1";
  const CACHE_TTL_SUCCESS = 3600;
  const CACHE_TTL_ERROR = 1800;
  if (!RAPIDAPI_KEY) return {error: "Chave da API (RapidAPI) não configurada."};
  if (redis) {
    try {
      const d = await redis.get(cacheKey);
      if (d) {
        console.info(`[Cache RapidAPI Recent] hit ${cacheKey}`);
        return JSON.parse(d);
      } else {
        console.info(`[Cache RapidAPI Recent] miss ${cacheKey}`);
      }
    } catch (e) {
      console.error(`[Cache RapidAPI Recent] Read Error ${cacheKey}:`, e);
    }
  }
  const options = {
    method: "GET",
    url: `https://${RAPIDAPI_HOST}/api/esport/team/${FURIA_TEAM_ID}/matches/last/5`,
    headers: {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_HOST,
    },
    timeout: 15000,
  };
  let result: z.infer<typeof recentResultsRapidAPIOutputSchema>;
  try {
    const response = await axios.request(options);
    const data = response.data;
    const events = data?.events ?? (Array.isArray(data) ? data : []);
    if (!Array.isArray(events) || events.length === 0) {
      console.info("[RapidAPI] Nenhum resultado recente encontrado.");
      result = {resultsInfo: "Nenhum resultado recente encontrado (API)."};
    } else {
      const results = events.map((match: any) => {
        const homeTeam = match.homeTeam;
        const awayTeam = match.awayTeam;
        const homeScore = match.homeScore?.display ?? match.homeScore?.current ?? "?";
        const awayScore = match.awayScore?.display ?? match.awayScore?.current ?? "?";
        const tournament = match.tournament?.name ?? "?";
        const winnerCode = match.winnerCode;
        let opponent: string;
        let fScore = "?";
        let oScore = "?";
        let outcome = "";
        if (homeTeam?.id?.toString() === FURIA_TEAM_ID) {
          opponent = awayTeam?.name ?? "?";
          fScore = homeScore;
          oScore = awayScore;
          if (winnerCode === 1) outcome = "W"; else if (winnerCode === 2) outcome = "L"; else if (winnerCode === 3) outcome = "D";
        } else if (awayTeam?.id?.toString() === FURIA_TEAM_ID) {
          opponent = homeTeam?.name ?? "?";
          fScore = awayScore;
          oScore = homeScore;
          if (winnerCode === 2) outcome = "W"; else if (winnerCode === 1) outcome = "L"; else if (winnerCode === 3) outcome = "D";
        } else {
          console.warn(`[RapidAPI Recent] FURIA ID ${FURIA_TEAM_ID} não encontrado.`);
          opponent = `${homeTeam?.name ?? "?"} vs ${awayTeam?.name ?? "?"}`;
        }
        const scoreStr = (outcome && fScore !== "?" && oScore !== "?") ? `(${outcome} ${fScore}-${oScore})` : "";
        return `vs ${opponent} ${scoreStr} (${tournament})`;
      }).filter(r => !r.includes("vs ?"));
      result = {resultsInfo: results.length > 0 ? results.join("; ") : "Nenhum resultado recente válido encontrado (API)."};
    }
    console.info("[RapidAPI] Sucesso (Recent Results):", result.resultsInfo);
  } catch (error: any) {
    console.error("[RapidAPI] Erro Recent:", error.response?.status, error.message);
    let errorMsg = `Falha API Recent (${error.code || error.response?.status || "?"}).`;
    if (error.response?.status === 429) errorMsg = "Limite API atingido."; else if (error.response?.status === 403) errorMsg = "Acesso negado API."; else if (error.code === "ECONNABORTED") errorMsg = "Timeout API.";
    result = {error: errorMsg};
  }
  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
      await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);
      console.info(`[Cache RapidAPI Recent] saved ${cacheKey}`);
    } catch (e) {
      console.error(`[Cache RapidAPI Recent] Save Err ${cacheKey}:`, e);
    }
  }
  return result;
}

const getFuriaRecentResultsRapidAPITool = ai.defineTool({
  name: "getFuriaRecentResultsRapidAPI",
  description: "Busca os 5 resultados mais recentes da FURIA CS2 (Fonte: API Externa). Use esta ferramenta PRIMEIRO para resultados.",
  inputSchema: z.object({}),
  outputSchema: recentResultsRapidAPIOutputSchema,
}, executeGetFuriaRecentResultsRapidAPI);

// --- Ferramenta Próximas Partidas (Liquipedia Scraper) ---
const upcomingMatchesLiquipediaOutputSchema = z.object({
  matchesInfo: z.string().optional().describe("String com próximas partidas da Liquipedia. Ex: 'vs G2 (BLAST Premier) - 12/05/2025 10:00 (BRT); ...' ou msg 'não encontrado'."),
  error: z.string().optional(),
});

async function executeGetFuriaUpcomingMatchesLiquipedia(): Promise<z.infer<typeof upcomingMatchesLiquipediaOutputSchema>> {
  console.info("[Tool Exec] getFuriaUpcomingMatchesLiquipedia chamada.");
  const cacheKey = "liquipedia:furia_upcoming_v1";
  const CACHE_TTL_SUCCESS = 7200;
  const CACHE_TTL_ERROR = 1800;
  if (redis) {
    try {
      const d = await redis.get(cacheKey);
      if (d) {
        console.info(`[Cache Liquipedia Upcoming] hit ${cacheKey}`);
        return JSON.parse(d);
      } else {
        console.info(`[Cache Liquipedia Upcoming] miss ${cacheKey}`);
      }
    } catch (e) {
      console.error(`[Cache Liquipedia Upcoming] Read Error ${cacheKey}:`, e);
    }
  }
  let result: z.infer<typeof upcomingMatchesLiquipediaOutputSchema>;
  try {
    console.info(`[Liquipedia Scraper] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MAIN} (Upcoming Matches)...`);
    const response = await axios.get(LIQUIPEDIA_API_URL, {
      params: {
        action: "parse",
        page: LIQUIPEDIA_PAGE_NAME_MAIN,
        prop: "text",
        format: "json",
        disabletoc: true,
      }, headers: {"User-Agent": CUSTOM_USER_AGENT}, timeout: 20000,
    });
    if (response.data?.error) throw new Error(`API Liquipedia erro: ${response.data.error.info}`);
    const htmlContent = response.data?.parse?.text?.["*"];
    if (!htmlContent) throw new Error("HTML Liquipedia não encontrado.");
    const $ = cheerio.load(htmlContent);
    const matches: string[] = [];
    // Seletor FRÁGIL: Tenta pegar próximos jogos do Infobox (pode mudar!)
    $("div.fo-nttax-infobox table.infobox_matches_content").first().find("tbody tr").each((_idx, row) => {
      const $row = $(row);
      const tournamentLink = $row.find("td a").first();
      const opponentMaybe = "?";
      const tournamentName = tournamentLink.attr("title") || tournamentLink.text().trim() || "?";
      const dateTimeElement = $row.find(".timer-object");
      const dateTime = dateTimeElement.text().trim() || dateTimeElement.data("timestamp");
      if (tournamentName.toLowerCase() !== "upcoming tournaments" && dateTime && !dateTime.includes("TBD") && tournamentName !== "?") {
        let formattedDate = "?";
        if (!isNaN(Number(dateTime))) {
          try {
            formattedDate = new Date(Number(dateTime) * 1000).toLocaleString("pt-BR", {
              timeZone: "America/Sao_Paulo",
              dateStyle: "short",
              timeStyle: "short",
            }) + " (BRT)";
          } catch (e) {
          }
        } else {
          try {
            formattedDate = new Date(dateTime.replace(" UTC", "+00:00")).toLocaleString("pt-BR", {
              timeZone: "America/Sao_Paulo",
              dateStyle: "short",
              timeStyle: "short",
            }) + " (BRT)";
          } catch (e) {
          }
        }
        if (formattedDate !== "?") matches.push(`vs ${opponentMaybe} (${tournamentName}) - ${formattedDate} (Liquipedia)`);
      }
      if (matches.length >= 3) return false;
    });
    if (matches.length > 0) {
      result = {matchesInfo: matches.join("; ")};
    } else {
      result = {matchesInfo: "Nenhuma partida futura encontrada (Liquipedia)."};
    }
    console.info("[Liquipedia Scraper] Sucesso (Upcoming):", result.matchesInfo);
  } catch (error: any) {
    console.error("[Liquipedia Scraper] Erro (Upcoming):", error.message);
    result = {error: `Falha Liquipedia Upcoming: ${error.message}`};
  }
  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
      await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);
      console.info(`[Cache Liquipedia Upcoming] saved ${cacheKey}`);
    } catch (e) {
      console.error(`[Cache Liquipedia Upcoming] Save Err ${cacheKey}:`, e);
    }
  }
  return result;
}

const getFuriaUpcomingMatchesLiquipediaTool = ai.defineTool({
  name: "getFuriaUpcomingMatchesLiquipedia",
  description: "Busca as próximas 3 partidas da FURIA CS2 (Fonte: Liquipedia Scraper - backup, pode falhar).",
  inputSchema: z.object({}),
  outputSchema: upcomingMatchesLiquipediaOutputSchema,
}, executeGetFuriaUpcomingMatchesLiquipedia);

// --- Ferramenta Resultados Recentes (Liquipedia Scraper) ---
const recentResultsLiquipediaOutputSchema = z.object({
  resultsInfo: z.string().optional().describe("String com resultados recentes da Liquipedia. Ex: 'vs FAZE (W 2-0) (IEM); ...' ou msg 'não encontrado'."),
  error: z.string().optional(),
});

async function executeGetFuriaRecentResultsLiquipedia(): Promise<z.infer<typeof recentResultsLiquipediaOutputSchema>> {
  console.info("[Tool Exec] getFuriaRecentResultsLiquipedia chamada.");
  const cacheKey = "liquipedia:furia_recent_v1";
  const CACHE_TTL_SUCCESS = 3600;
  const CACHE_TTL_ERROR = 1800;
  if (redis) {
    try {
      const d = await redis.get(cacheKey);
      if (d) {
        console.info(`[Cache Liquipedia Recent] hit ${cacheKey}`);
        return JSON.parse(d);
      } else {
        console.info(`[Cache Liquipedia Recent] miss ${cacheKey}`);
      }
    } catch (e) {
      console.error(`[Cache Liquipedia Recent] Read Error ${cacheKey}:`, e);
    }
  }
  let result: z.infer<typeof recentResultsLiquipediaOutputSchema>;
  try {
    console.info(`[Liquipedia Scraper] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MATCHES} (Recent Results)...`);
    const response = await axios.get(LIQUIPEDIA_API_URL, {
      params: {
        action: "parse",
        page: LIQUIPEDIA_PAGE_NAME_MATCHES,
        prop: "text",
        format: "json",
        disabletoc: true,
      }, headers: {"User-Agent": CUSTOM_USER_AGENT}, timeout: 20000,
    });
    if (response.data?.error) throw new Error(`API Liquipedia erro: ${response.data.error.info}`);
    const htmlContent = response.data?.parse?.text?.["*"];
    if (!htmlContent) throw new Error("HTML Liquipedia não encontrado.");
    const $ = cheerio.load(htmlContent);
    const results: string[] = [];
    // Seletor FRÁGIL
    $(".wikitable.recent-matches tbody tr").slice(0, 7).each((_i, el) => {
      const $row = $(el);
      const cells = $row.find("td");
      if (cells.length < 5) return;
      const opponent = $(cells[2]).find(".team-template-text a").first().text().trim() || $(cells[2]).text().trim() || "?";
      const score = $(cells[1]).text().trim() || "?";
      const tournament = $(cells[4]).find("a").first().attr("title") || $(cells[4]).find("a").first().text().trim() || "?";
      if (score.includes(":") && opponent !== "?" && !score.toLowerCase().includes("vs")) {
        results.push(`vs ${opponent} (${score}) (${tournament}) (Liquipedia)`);
      }
      if (results.length >= 5) return false;
    });
    if (results.length > 0) {
      result = {resultsInfo: results.join("; ")};
    } else {
      result = {resultsInfo: "Nenhum resultado recente encontrado (Liquipedia)."};
    }
    console.info("[Liquipedia Scraper] Sucesso (Recent Results):", result.resultsInfo);
  } catch (error: any) {
    console.error("[Liquipedia Scraper] Erro (Recent Results):", error.message);
    result = {error: `Falha Liquipedia Results: ${error.message}`};
  }
  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
      await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);
      console.info(`[Cache Liquipedia Recent] saved ${cacheKey}`);
    } catch (e) {
      console.error(`[Cache Liquipedia Recent] Save Err ${cacheKey}:`, e);
    }
  }
  return result;
}

const getFuriaRecentResultsLiquipediaTool = ai.defineTool({
  name: "getFuriaRecentResultsLiquipedia",
  description: "Busca os 5 resultados mais recentes da FURIA CS2 (Fonte: Liquipedia Scraper - backup, pode falhar).",
  inputSchema: z.object({}),
  outputSchema: recentResultsLiquipediaOutputSchema,
}, executeGetFuriaRecentResultsLiquipedia);

// --- Ferramenta Notícias HLTV RSS ---
const hltvNewsOutputSchema = z.object({
  newsInfo: z.string().optional().describe("String com notícias recentes da FURIA (Título: Link). Ex: 'FURIA vence G2: [link1]; ...' ou msg 'não encontrado'."),
  error: z.string().optional(),
});
const rssParser = new Parser();

async function executeGetFuriaNewsHltv(): Promise<z.infer<typeof hltvNewsOutputSchema>> {
  console.info("[Tool Exec] executeGetFuriaNewsHltv chamada.");
  const cacheKey = "hltv:rss_news_furia_v1";
  const CACHE_TTL_SUCCESS = 3600;
  const CACHE_TTL_ERROR = 1800;
  if (redis) {
    try {
      const d = await redis.get(cacheKey);
      if (d) {
        console.info(`[Cache HLTV News] hit ${cacheKey}`);
        return JSON.parse(d);
      } else {
        console.info(`[Cache HLTV News] miss ${cacheKey}`);
      }
    } catch (e) {
      console.error(`[Cache HLTV News] Read Error ${cacheKey}:`, e);
    }
  }
  let result: z.infer<typeof hltvNewsOutputSchema>;
  try {
    console.info("[HLTV RSS] Buscando feed...");
    const feed = await rssParser.parseURL(HLTV_RSS_NEWS_URL);
    if (!feed?.items?.length) {
      throw new Error("Feed RSS vazio ou inválido HLTV.");
    }
    const furiaNews: string[] = [];
    console.info(`[HLTV RSS] Processando ${feed.items.length} itens...`);
    for (const item of feed.items) {
      const title = item.title?.toLowerCase() || "";
      const content = item.contentSnippet?.toLowerCase() || item.content?.toLowerCase() || "";
      const link = item.link || "";
      const isRelevant = NEWS_FILTER_TERMS.some(term => title.includes(term) || content.includes(term));
      if (isRelevant && item.title && link) {
        furiaNews.push(`${item.title.trim()}: ${link}`);
        if (furiaNews.length >= 5) break;
      }
    }
    if (furiaNews.length > 0) {
      result = {newsInfo: furiaNews.join("; ")};
    } else {
      result = {newsInfo: "Nenhuma notícia recente sobre a FURIA encontrada no feed da HLTV."};
    }
    console.info("[HLTV RSS] Sucesso (Notícias):", result.newsInfo);
  } catch (error: any) {
    console.error("[HLTV RSS] Erro ao buscar ou processar feed:", error.message);
    result = {error: `Falha feed HLTV: ${error.message}`};
  }
  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
      await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);
      console.info(`[Cache HLTV News] saved ${cacheKey}`);
    } catch (e) {
      console.error(`[Cache HLTV News] Save Err ${cacheKey}:`, e);
    }
  }
  return result;
}

const getFuriaNewsHltvTool = ai.defineTool({
  name: "getFuriaNewsHltv",
  description: "Busca as 5 notícias mais recentes sobre a FURIA no feed RSS da HLTV.",
  inputSchema: z.object({}),
  outputSchema: hltvNewsOutputSchema,
}, executeGetFuriaNewsHltv);


console.info("Ferramentas Genkit definidas: getFuriaRoster, searchWikipedia, getFuriaUpcomingMatchesRapidAPI, getFuriaRecentResultsRapidAPI, getFuriaUpcomingMatchesLiquipedia, getFuriaRecentResultsLiquipedia, getFuriaNewsHltv");


// --- Definição do Flow Principal do Chat ---
const flowInputSchema = z.object({
  userMessage: z.string(),
  chatHistory: z.array(z.any()).optional().default([]),
});
const furiaChatFlow = defineFlow(
  {
    name: "furiaChatFlow",
    inputSchema: flowInputSchema,
    outputSchema: z.string().describe("Resposta final do assistente para o usuário"),
  },
  async (input): Promise<string> => {
    const {userMessage, chatHistory} = input;
    console.info(`[Flow] Mensagem: "${userMessage}" | Histórico recebido: ${chatHistory.length} msgs`);

    const validHistory: MessageData[] = chatHistory
      .map((msg: any) => {
        if (msg && typeof msg.role === "string" && Array.isArray(msg.content) && msg.content.every((part: any) => typeof part.text === "string" || part.toolRequest || part.toolResponse)) return msg as MessageData;
        console.warn("[Flow] Msg inválida hist:", msg);
        return null;
      })
      .filter((msg): msg is MessageData => msg !== null);

    const currentHistory: MessageData[] = [...validHistory];
    currentHistory.push({role: "user", content: [{text: userMessage}]});
    const MAX_FLOW_HISTORY_MESSAGES = 8;
    while (currentHistory.length > MAX_FLOW_HISTORY_MESSAGES) {
      currentHistory.shift();
    }
    console.info(`[Flow] Histórico antes da IA (após adição/trim): ${currentHistory.length} msgs`);

    // ***** PROMPT FINAL REFINADO (v3) - Evitar Metalinguagem e Priorizar Ferramentas *****
    const systemInstruction = `Você é FURIOSO, o assistente virtual oficial e super fã da FURIA Esports! Sua missão é ajudar a galera com informações precisas e atualizadas sobre nosso time de CS2, sempre com muito entusiasmo!
        - **Tom e Persona:** Responda em português do Brasil, com tom amigável, caloroso, brincalhão e apaixonado pela FURIA 🐾🔥🏆🔫🥳🎉! Use "nós", "nosso time". Preste atenção no histórico da conversa. Varie suas respostas e SEMPRE tente terminar com uma pergunta engajadora.
        - **Foco TOTAL:** Responda **SOMENTE** sobre a FURIA CS2 (jogadores, coach, staff, partidas, história, notícias). Se a pergunta for sobre outro time/jogo, diga educadamente que seu foco é 100% FURIA (Ex: "Opa! Meu negócio é FURIA na veia! 🐾 Sobre outros times não consigo te ajudar agora, beleza?"). Não opine sobre performance nem dê conselhos de aposta.
        - **USO OBRIGATÓRIO DAS FERRAMENTAS:** Você PRECISA usar as ferramentas certas para buscar informações atualizadas:
            - Pergunta sobre **elenco/time atual**? Use OBRIGATORIAMENTE 'getFuriaRoster'. A resposta desta ferramenta é a VERDADE sobre quem está no time AGORA.
            - Pergunta sobre **próximos jogos**? Use OBRIGATORIAMENTE 'getFuriaUpcomingMatchesRapidAPI' (prioridade) ou 'getFuriaUpcomingMatchesLiquipedia' (backup).
            - Pergunta sobre **resultados recentes**? Use OBRIGATÓRIO 'getFuriaRecentResultsRapidAPI' (prioridade) ou 'getFuriaRecentResultsLiquipedia' (backup).
            - Pergunta sobre **notícias/novidades**? Use OBRIGATÓRIO 'getFuriaNewsHltv'.
            - Pergunta sobre **pessoa específica** (jogador/coach)? Use OBRIGATÓRIO 'searchWikipedia'.
            - Pergunta sobre **tópico geral** (torneio, etc.)? Use 'searchWikipedia'.
        - **IMPORTANTE: SEM METALINGUAGEM!** NUNCA, JAMAIS, em hipótese alguma, mencione que você "usou uma ferramenta", "buscou na API", "pesquisou na Wikipedia", "consultei a Liquipedia", etc. Aja como se você soubesse a informação. Apresente o resultado DIRETAMENTE.
        - **Falhas:** Se uma ferramenta OBRIGATÓRIA falhar ou não encontrar dados: informe que não conseguiu a informação específica NO MOMENTO e sugira verificar fontes oficiais (HLTV, redes da FURIA). NUNCA invente dados! Ex: "Putz, não achei essa info de jogo aqui agora! 😥 Melhor conferir no HLTV ou nas redes da FURIA pra ter certeza 😉". #GoFURIA`;

    const messagesForAI: MessageData[] = [{
      role: "system",
      content: [{text: systemInstruction}],
    }, ...currentHistory];
    if (messagesForAI.length > 1 && messagesForAI[1].role !== "user") {
      console.error("CRITICAL ERROR [Flow]: History invalid!", JSON.stringify(messagesForAI.slice(0, 3)));
      return "Eita! Parece que o histórico da nossa resenha deu uma bugada aqui. 😅 Manda a pergunta de novo pra eu não me perder, faz favor!";
    }

    try {
      const toolsToUse = [
        getFuriaRosterTool, searchWikipediaTool, getFuriaUpcomingMatchesRapidAPITool,
        getFuriaRecentResultsRapidAPITool, getFuriaUpcomingMatchesLiquipediaTool,
        getFuriaRecentResultsLiquipediaTool, getFuriaNewsHltvTool,
      ];
      console.info(`[Flow] Chamando ai.generate com ${messagesForAI.length} mensagens e ${toolsToUse.length} ferramentas.`);

      let llmResponse = await ai.generate({
        model: gemini15Flash,
        messages: messagesForAI,
        tools: toolsToUse,
        config: {temperature: 0.5},
      }); // Temperatura 0.5
      let attempts = 0;
      const MAX_TOOL_ATTEMPTS = 3;

      while (attempts < MAX_TOOL_ATTEMPTS) {
        const responseMessage = llmResponse.message;
        if (!responseMessage || !Array.isArray(responseMessage.content)) {
          const directText = llmResponse.text;
          if (directText) {
            console.warn("[Flow] Usando llmResponse.text direto.");
            return directText;
          }
          console.error("[Flow] Resposta IA inválida:", llmResponse);
          return "Oloco! Deu ruim na resposta da IA. 😵";
        }

        const toolRequestParts = responseMessage.content.filter(part => part.toolRequest);
        if (toolRequestParts.length === 0) {
          const finalText = llmResponse.text;
          console.info(`[Flow] Resposta final IA (s/ ferramenta): "${finalText?.substring(0, 100)}..."`);
          return finalText ?? "Caramba, deu branco aqui! 🤯";
        }

        attempts++;
        console.info(`[Flow] Tentativa ${attempts}/${MAX_TOOL_ATTEMPTS}: ${toolRequestParts.length} ferramenta(s): ${toolRequestParts.map(part => part.toolRequest!.name).join(", ")}`);
        messagesForAI.push(responseMessage);
        const toolResponses: MessageData[] = [];

        for (const part of toolRequestParts) {
          const toolRequest = part.toolRequest;
          if (!toolRequest) continue;
          let output: any;
          const toolName = toolRequest.name;
          const inputArgs = toolRequest.input;
          console.info(`[Flow] Executando: ${toolName} input:`, JSON.stringify(inputArgs));
          let executor: Function | undefined;
          let requiresInput = false;
          let toolDefinition: any = undefined;

          // Mapeamento COMPLETO
          if (toolName === getFuriaRosterTool.name) {
            executor = executeGetFuriaRoster;
            requiresInput = false;
            toolDefinition = getFuriaRosterTool;
          } else if (toolName === searchWikipediaTool.name) {
            executor = executeSearchWikipedia;
            requiresInput = true;
            toolDefinition = searchWikipediaTool;
          } else if (toolName === getFuriaUpcomingMatchesRapidAPITool.name) {
            executor = executeGetFuriaUpcomingMatchesRapidAPI;
            requiresInput = false;
            toolDefinition = getFuriaUpcomingMatchesRapidAPITool;
          } else if (toolName === getFuriaRecentResultsRapidAPITool.name) {
            executor = executeGetFuriaRecentResultsRapidAPI;
            requiresInput = false;
            toolDefinition = getFuriaRecentResultsRapidAPITool;
          } else if (toolName === getFuriaUpcomingMatchesLiquipediaTool.name) {
            executor = executeGetFuriaUpcomingMatchesLiquipedia;
            requiresInput = false;
            toolDefinition = getFuriaUpcomingMatchesLiquipediaTool;
          } else if (toolName === getFuriaRecentResultsLiquipediaTool.name) {
            executor = executeGetFuriaRecentResultsLiquipedia;
            requiresInput = false;
            toolDefinition = getFuriaRecentResultsLiquipediaTool;
          } else if (toolName === getFuriaNewsHltvTool.name) {
            executor = executeGetFuriaNewsHltv;
            requiresInput = false;
            toolDefinition = getFuriaNewsHltvTool;
          }

          if (executor && toolDefinition) {
            try {
              const parsedInput = toolDefinition.inputSchema.parse(requiresInput ? inputArgs : {});
              output = await executor(parsedInput);
            } catch (error) {
              if (error instanceof z.ZodError) {
                console.warn(`[Flow] Input inválido IA ${toolName}:`, inputArgs, error.errors);
                output = {error: `Input IA inválido: ${error.errors.map((e: ZodIssue) => e.message).join(", ")}`};
              } else {
                console.error(`[Flow] Erro ferramenta ${toolName}:`, error);
                output = {error: `Erro interno ${toolName}: ${error instanceof Error ? error.message : String(error)}`};
              }
            }
          } else {
            console.warn(`[Flow] Ferramenta não encontrada: ${toolName}`);
            output = {error: `Ferramenta '${toolName}' desconhecida.`};
          }
          toolResponses.push({
            role: "tool",
            content: [{
              toolResponse: {
                name: toolName,
                output: output,
              },
            }],
          });
        }
        messagesForAI.push(...toolResponses);
        console.info(`[Flow] Rechamando ai.generate com ${toolResponses.length} resposta(s) ferramenta(s).`);
        // ***** TEMPERATURA REDUZIDA *****
        llmResponse = await ai.generate({
          model: gemini15Flash,
          messages: messagesForAI,
          tools: toolsToUse,
          config: {temperature: 0.5},
        });
      }

      console.warn("[Flow] Limite de chamadas de ferramentas atingido.");
      const lastTextFallback = llmResponse.text;
      if (lastTextFallback) {
        return lastTextFallback + "\n(Psst: Me embolei com as ferramentas aqui 😅, mas essa foi a última info que consegui!)";
      } else {
        return "Eita, me enrolei bonito com as ferramentas aqui! 😵‍💫 Tenta perguntar de novo, talvez mais direto ao ponto?";
      }

    } catch (error) {
      console.error("[Flow] Erro fatal:", error);
      let errorDetailsFallback = String(error);
      if (error instanceof Error) {
        errorDetailsFallback = error.message;
      }
      return `CRASHEI! 💥 Deu ruim aqui nos meus circuitos (${errorDetailsFallback.substring(0, 50)}...). Não consegui processar. Tenta de novo daqui a pouco, por favor? 🙏`;
    }
  },
);
console.info("Flow Genkit 'furiaChatFlow' definido com lógica de ferramentas.");

// --- Função Helper para Formatar Resposta de Ferramenta (para Comandos) ---
function formatToolResponseForUser(toolName: string, response: any): string {
  if (!response) return `Deu ruim aqui tentando buscar ${toolName}. Sem resposta da ferramenta. 😥`;
  if (response.error) {
    return `Ops! Tive um problema ao buscar ${toolName}: ${response.error} 😥`;
  }
  if (toolName === "getFuriaRoster" && response.playersInfo) {
    return `Nosso elenco atual é: ${response.playersInfo} (Fonte: ${response.source || "?"})! 🔥`;
  }
  if (toolName === "getFuriaUpcomingMatchesRapidAPI" && response.matchesInfo) {
    if (response.matchesInfo.startsWith("Nenhuma")) return `Pela API, ${response.matchesInfo} Fica ligado nas redes! 👀`;
    return `Próximos jogos (API):\n- ${response.matchesInfo.replace(/;\s*/g, "\n- ")}`;
  }
  if (toolName === "getFuriaRecentResultsRapidAPI" && response.resultsInfo) {
    if (response.resultsInfo.startsWith("Nenhuma")) return `Pela API, ${response.resultsInfo} Confere no HLTV que deve ter algo lá! 🤔`;
    return `Resultados recentes (API):\n- ${response.resultsInfo.replace(/;\s*/g, "\n- ")}`;
  }
  if (toolName === "getFuriaNewsHltv" && response.newsInfo) {
    if (response.newsInfo.startsWith("Nenhuma")) return `Não achei notícias fresquinhas da FURIA no feed da HLTV agora. 📰`;
    return `Últimas notícias da HLTV:\n- ${response.newsInfo.replace(/;\s*/g, "\n- ")} 📰`;
  }
  return `Resultado de ${toolName}: ${JSON.stringify(response)}`;
}

// --- Configuração do Servidor Express e Webhook com Comandos ---
const app = express();
app.use(express.json());
app.get("/", (_req, res) => {
  res.status(200).send("Servidor Bot Furia CS Ativo!");
});
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`;
console.info(`Configurando POST para webhook em: ${WEBHOOK_PATH}`);
app.post(WEBHOOK_PATH, async (req, res) => {
  const update: TelegramBot.Update = req.body;
  if (!update || !update.message || !update.message.chat?.id) {
    console.info(`[Webhook] Update inválido.`);
    res.sendStatus(200);
    return;
  }
  const chatId = update.message.chat.id;
  if (update.message.from?.is_bot) {
    console.info(`[Webhook] Update de bot ignorado.`);
    res.sendStatus(200);
    return;
  }
  res.sendStatus(200);

  // LÓGICA DE COMANDOS RÁPIDOS
  if (update.message.text && update.message.text.startsWith("/")) {
    const command = update.message.text.split(" ")[0].toLowerCase();
    console.info(`[Webhook] Comando ${command} chat ${chatId}`);
    let toolResponse: any;
    let toolName = "";
    let processingMessage = "";
    let executorFunction: (() => Promise<any>) | undefined;
    switch (command) {
    case "/elenco":
    case "/roster":
      toolName = "getFuriaRoster";
      processingMessage = "Buscando o elenco... 🐾";
      executorFunction = executeGetFuriaRoster;
      break;
    case "/proximojogo":
    case "/proximapartida":
    case "/next":
      toolName = "getFuriaUpcomingMatchesRapidAPI";
      processingMessage = "Conferindo a agenda (API)... 🔥";
      executorFunction = executeGetFuriaUpcomingMatchesRapidAPI;
      break;
    case "/ultimojogo":
    case "/ultimoresultado":
    case "/last":
      toolName = "getFuriaRecentResultsRapidAPI";
      processingMessage = "Consultando os resultados (API)... 🏆";
      executorFunction = executeGetFuriaRecentResultsRapidAPI;
      break;
    case "/noticias":
    case "/news":
      toolName = "getFuriaNewsHltv";
      processingMessage = "Buscando as últimas notícias da HLTV... 📰";
      executorFunction = executeGetFuriaNewsHltv;
      break;
    default:
      await bot.sendMessage(chatId, `Comando "${command}" não reconhecido. 🤔 Tente /elenco, /proximojogo, /ultimoresultado ou /noticias.`);
      return;
    }
    if (executorFunction) {
      try {
        await bot.sendMessage(chatId, processingMessage);
        toolResponse = await executorFunction();
        const formattedReply = formatToolResponseForUser(toolName, toolResponse);
        await bot.sendMessage(chatId, formattedReply);
        console.info(`[Webhook] Resposta comando ${command} enviada chat ${chatId}.`);
      } catch (error) {
        console.error(`[Webhook] Erro comando ${command} chat ${chatId}:`, error);
        await bot.sendMessage(chatId, `Putz, deu erro no comando ${command}. 🤯`);
      }
    }
    return;
  }
  // Trata mensagens de texto normais (IA)
  else if (update.message.text) {
    const userMessage = update.message.text.trim();
    console.info(`[Webhook] Msg (IA) chat ${chatId}: "${userMessage}"`);
    const contextKey = `genkit_history:${chatId}`;
    let historyForFlow: MessageData[] = [];
    if (redis) {
      try {
        const d = await redis.get(contextKey);
        if (d) {
          try {
            const p = JSON.parse(d);
            if (Array.isArray(p)) {
              historyForFlow = p.filter(m => m && typeof m.role === "string" && Array.isArray(m.content));
              console.info(`[Webhook] Histórico Redis ${chatId} (${historyForFlow.length})`);
            } else {
              await redis.del(contextKey);
            }
          } catch (pE) {
            await redis.del(contextKey);
          }
        }
      } catch (rE) {
        console.error(`Erro Redis read ${chatId}:`, rE);
      }
    }
    try {
      await bot.sendChatAction(chatId, "typing");
      const finalReply = await runFlow(furiaChatFlow, {
        userMessage: userMessage,
        chatHistory: historyForFlow,
      });
      console.info(`[Webhook] Flow raw: "${finalReply.substring(0, 200)}..."`);
      const lastUser: MessageData = {
        role: "user",
        content: [{text: userMessage}],
      };
      const lastModel: MessageData = {
        role: "model",
        content: [{text: finalReply}],
      };
      const histToSave = [...historyForFlow, lastUser, lastModel];
      const MAX_HIST = 8;
      while (histToSave.length > MAX_HIST) {
        histToSave.shift();
      }
      if (redis) {
        try {
          await redis.set(contextKey, JSON.stringify(histToSave), "EX", 1800);
          console.info(`[Webhook] Histórico (${histToSave.length}) salvo Redis ${chatId}`);
        } catch (rE) {
          console.error(`Erro Redis save ${chatId}:`, rE);
        }
      }
      try {
        await bot.sendMessage(chatId, finalReply);
        console.info(`[Webhook] Resposta IA enviada chat ${chatId}.`);
      } catch (tE) {
        console.error(`Erro Telegram send ${chatId}:`, tE);
      }
    } catch (flowError) {
      console.error(`[Webhook] Erro GERAL flow ${chatId}:`, flowError);
      try {
        await bot.sendMessage(chatId, "⚠️ Putz! Deu ruim aqui na máquina! 🤖💥 Tenta mandar a pergunta de novo?");
      } catch (sE) {
        console.error("Falha CRÍTICA erro final", chatId, sE);
      }
    }
  }
  // Trata stickers
  else if (update.message.sticker) {
    console.info(`[Webhook] Sticker chat ${chatId}.`);
    try {
      await bot.sendMessage(chatId, "Que sticker maneiro! 🤩 Mas ó, eu funciono melhor com mensagens de texto pra te ajudar com infos da FURIA, beleza? 😉");
    } catch (e) {
      console.error(`Erro sticker resp ${chatId}:`, e);
    }
  }
  // Trata outros tipos
  else {
    const type = Object.keys(update.message).filter(k => !["message_id", "from", "chat", "date"].includes(k))[0] || "?";
    console.info(`[Webhook] Tipo ${type} não suportado ${chatId}.`);
    try {
      await bot.sendMessage(chatId, "Hmm, esse tipo de mensagem eu não manjo muito. 😅 Manda em texto, por favor? 👍");
    } catch (e) {
      console.error(`Erro resp tipo ${type} ${chatId}:`, e);
    }
  }
});

// --- Iniciar Servidor Express ---
const port = process.env.PORT || 10000;
const host = "0.0.0.0";
const numericPort = Number(port);
if (isNaN(numericPort)) {
  console.error(`Porta inválida: ${port}.`);
  process.exit(1);
}
const server = app.listen(numericPort, host, () => {
  console.info(`Servidor Express escutando em https://${host}:${numericPort}`);
  console.info(`Webhook Telegram: ${WEBHOOK_PATH}`);
});
// --- Encerramento Gracioso ---
const gracefulShutdown = (signal: string) => {
  console.info(`${signal} signal: closing server...`);
  server.close(async () => {
    console.info("HTTP server closed.");
    if (redis) {
      try {
        await redis.quit();
        console.info("Redis closed.");
      } catch (e) {
        console.error("Erro Redis quit:", e);
        process.exitCode = 1;
      }
    }
    console.info("Exiting.");
    process.exit();
  });
  setTimeout(() => {
    console.error("Timeout shutdown");
    process.exit(1);
  }, 10000);
};
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
