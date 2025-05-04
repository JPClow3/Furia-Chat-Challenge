/* eslint-disable */
// index.ts
// Versão Otimizada v5 (Correções Finais TS Erros Build, Completo)

import * as dotenv from "dotenv";
import express from "express";
import type {ZodIssue, ZodTypeAny} from "zod";
import * as z from "zod";

// --- Imports Genkit ---
// <<< CORREÇÃO: GenerationResponse -> GenerateResponse >>>
// <<< CORREÇÃO: Adicionar Part >>>
import {GenerateResponse, genkit, MessageData, Part, ToolAction} from "genkit";
import {gemini15Flash, googleAI} from "@genkit-ai/googleai";
import {defineFlow, runFlow} from "@genkit-ai/flow";

// --- Imports das Ferramentas e Outros ---
import HLTV from "hltv";
import wiki from "wikipedia";
import * as path from "node:path";
import TelegramBot from "node-telegram-bot-api"; // Import ChatId type
import Redis from "ioredis";
import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import {performance} from "perf_hooks";

// --- Carregamento de Variáveis de Ambiente ---
dotenv.config({ path: path.resolve(__dirname, '../.env') });
console.log('--- DEBUG ENV VARS ---');
console.log('RAPIDAPI_KEY:', process.env.RAPIDAPI_KEY ? 'Presente' : 'AUSENTE! API de partidas pode não funcionar.');
console.log('--- END DEBUG ---');

// --- Configuração do Cliente Redis ---
const redisUrl = process.env.REDIS_URL;
let redis: Redis | null = null;
if (redisUrl) {
  try {
    redis = new Redis(redisUrl);
    console.info("[Init] Conexão Redis OK.");
    redis.on('error', (err) => console.error("[Redis Error]", err));
  } catch (err) { console.error("[Init] Falha Redis:", err); }
} else { console.warn("[Init] REDIS_URL não definida."); }

// --- Configuração do Bot Telegram ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const contactInfo = process.env.CONTACT_EMAIL || 'bot-dev@example.com';
if (!telegramToken) { console.error("[Init Error] TELEGRAM_BOT_TOKEN não definido!"); throw new Error("Token Telegram não configurado."); }
if (contactInfo === 'bot-dev@example.com') { console.warn("[Init] AVISO: Variável de ambiente CONTACT_EMAIL não definida ou usando fallback."); }
console.info("[Init] Token Telegram OK.");
const bot = new TelegramBot(telegramToken);
console.info("[Init] Instância Bot Telegram OK.");

// --- Inicialização do Genkit ---
console.info("[Init] Inicializando Genkit com plugin googleAI...");
const ai = genkit({ plugins: [googleAI()] });
console.info("[Init] Instância Genkit 'ai' criada.");

// --- Constantes ---
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'esportapi1.p.rapidapi.com';
const FURIA_TEAM_ID = '364252'; // Certifique-se que este é o ID correto na RapidAPI
const FURIA_HLTV_ID = 8297; // ID da FURIA na HLTV
const LIQUIPEDIA_API_URL = 'https://liquipedia.net/counterstrike/api.php';
const LIQUIPEDIA_PAGE_NAME_MAIN = 'FURIA';
const LIQUIPEDIA_PAGE_NAME_MATCHES = 'FURIA/Matches';
const HLTV_RSS_NEWS_URL = 'https://www.hltv.org/rss/news';
const CUSTOM_USER_AGENT = `FuriaChatChallengeBot/1.1 (${contactInfo})`;
const NEWS_FILTER_TERMS = ['furia', 'yuurih', 'kscerato', 'fallen', 'molodoy', 'yekindar', 'sidde', 'guerri'];

// Cache TTLs
const CACHE_TTL_SUCCESS_ROSTER = 14400; const CACHE_TTL_SUCCESS_MATCHES = 7200; const CACHE_TTL_SUCCESS_RESULTS = 3600; const CACHE_TTL_SUCCESS_NEWS = 3600; const CACHE_TTL_SUCCESS_WIKI = 86400;
const CACHE_TTL_ERROR = 900; // 15 minutos

// Timeouts
const AXIOS_TIMEOUT_LIQUIPEDIA = 15000; const AXIOS_TIMEOUT_RAPIDAPI = 10000; const HLTV_TIMEOUT = 10000; const RSS_TIMEOUT = 10000;

// --- Definição das Ferramentas ---

// --- Ferramenta Roster ---
export enum TeamPlayerType { Coach = "Coach", Starter = "Starter", Substitute = "Substitute", Benched = "Benched" }
const rosterResultSchema = z.object({ playersInfo: z.string().optional(), error: z.string().optional(), source: z.enum(['HLTV', 'Liquipedia', 'Cache']).optional(), fetchTimeMs: z.number().optional() });
type RosterResult = z.infer<typeof rosterResultSchema>;

async function _fetchHltvRoster(): Promise<RosterResult> {
  const startTime = performance.now();
  console.info("[HLTV Fetch] Tentando buscar dados...");
  try {
    const getTeamPromise = HLTV.getTeam({ id: FURIA_HLTV_ID }); // Usando constante
    const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout HLTV (${HLTV_TIMEOUT}ms)`)), HLTV_TIMEOUT));

    // Tipagem mais segura para Promise.race
    const team = await Promise.race([getTeamPromise, timeoutPromise]) as Exclude<Awaited<ReturnType<typeof HLTV.getTeam>>, undefined>;

    if (!team || !team.players || team.players.length === 0) throw new Error("Dados HLTV não encontrados ou vazios.");
    const players = team.players.map(p => p.name ? `${p.name}${p.type===TeamPlayerType.Coach ? ' (Coach)' : ''}` : null).filter((p): p is string => p !== null);
    if (players.length === 0) throw new Error("Jogadores HLTV não encontrados.");
    const playersInfo = players.join(', ');
    const fetchTimeMs = Math.round(performance.now() - startTime);
    console.info(`[HLTV Fetch] Sucesso: ${playersInfo.substring(0, 50)}... (em ${fetchTimeMs}ms)`);
    return { playersInfo, source: 'HLTV', fetchTimeMs };
  } catch (err) {
    const fetchTimeMs = Math.round(performance.now() - startTime);
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isCloudflareBlock = errorMsg.includes('Cloudflare') || errorMsg.includes('Access denied') || errorMsg.includes('status code 403') || errorMsg.includes('503 Service Temporarily Unavailable');
    const finalError = `Falha HLTV${isCloudflareBlock ? ' (Bloqueio Cloudflare/Servidor)' : ''}: ${errorMsg.substring(0, 100)}`;
    console.warn(`[HLTV Fetch] Erro: ${finalError} (em ${fetchTimeMs}ms)`);
    return { error: finalError, source: 'HLTV', fetchTimeMs };
  }
}

async function _fetchLiquipediaRoster(): Promise<RosterResult> {
  const startTime = performance.now();
  console.info(`[Liquipedia Fetch Roster] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MAIN}...`);
  try {
    const response = await axios.get(LIQUIPEDIA_API_URL, {
      params: { action: 'parse', page: LIQUIPEDIA_PAGE_NAME_MAIN, prop: 'text', format: 'json', disabletoc: true },
      headers: { 'User-Agent': CUSTOM_USER_AGENT },
      timeout: AXIOS_TIMEOUT_LIQUIPEDIA
    });

    if (response.data?.error) throw new Error(`API Liquipedia erro: ${response.data.error.info}`);
    const htmlContent = response.data?.parse?.text?.['*'];
    if (!htmlContent) throw new Error("HTML Liquipedia não encontrado.");

    const $ = cheerio.load(htmlContent);
    const players: string[] = [];
    const activeHeader = $('h3 > span#Active');
    if (activeHeader.length === 0) throw new Error("Header 'Active' não encontrado no HTML.");
    const rosterTableWrapper = activeHeader.closest('h3').nextAll('div.table-responsive.roster-card-wrapper').first();
    const rosterTable = rosterTableWrapper.find('table.wikitable.roster-card').first();
    if (rosterTable.length === 0) throw new Error("Tabela roster-card não encontrada após 'Active'.");

    console.info("[Liquipedia Parser Roster] Tabela 'Active' encontrada, processando...");
    rosterTable.find('tbody tr.Player').each((_i, r) => {
      const link = $(r).find('td.ID a').first();
      let name = link.attr('title');
      if (!name || name.includes('does not exist')) { name = link.text().trim(); }
      if (name) {
        const roleText = $(r).find('td.Position i').text().trim();
        name = name.replace(/\(.*\)/, '').trim();
        const role = roleText ? roleText : '';
        players.push(role ? `${name} ${role}` : name);
      }
    });

    if (players.length > 0) {
      const info = players.join(', ');
      const fetchTimeMs = Math.round(performance.now() - startTime);
      console.info(`[Liquipedia Fetch Roster] Sucesso: ${info.substring(0,50)}... (em ${fetchTimeMs}ms)`);
      return { playersInfo: info, source: 'Liquipedia', fetchTimeMs };
    } else {
      throw new Error("Extração da tabela 'Active' resultou em lista vazia.");
    }
  } catch (err) {
    const fetchTimeMs = Math.round(performance.now() - startTime);
    const msg = err instanceof Error ? err.message : String(err);
    const finalError = `Falha Liquipedia (Roster): ${msg.substring(0, 100)}`;
    console.error(`[Liquipedia Fetch Roster] Erro: ${finalError} (em ${fetchTimeMs}ms)`);
    return { error: finalError, source: 'Liquipedia', fetchTimeMs };
  }
}

async function executeGetFuriaRoster(): Promise<RosterResult> {
  const toolStartTime = performance.now();
  console.info("[Tool Exec Roster] Iniciando busca paralela (HLTV & Liquipedia)...");
  const cacheKey = "furia_roster_combined_v4";

  if (redis) {
    try {
      console.time(`[Cache Roster Read ${cacheKey}]`);
      const cachedData = await redis.get(cacheKey);
      console.timeEnd(`[Cache Roster Read ${cacheKey}]`);
      if (cachedData) {
        try {
          // Tenta validar o dado cacheado (que deve ter source HLTV ou Liquipedia)
          const validationSchema = rosterResultSchema.extend({ source: z.enum(['HLTV', 'Liquipedia']).optional() });
          const parsedData = validationSchema.parse(JSON.parse(cachedData));
          if (parsedData.playersInfo) {
            console.info(`[Cache Roster] HIT ${cacheKey}`);
            return { ...parsedData, source: 'Cache', fetchTimeMs: parsedData.fetchTimeMs }; // Retorna source 'Cache'
          } else {
            console.warn(`[Cache Roster] HIT com erro cacheado ${cacheKey}: ${parsedData.error?.substring(0,100)}...`);
          }
        } catch (parseError) {
          console.warn(`[Cache Roster] Erro ao parsear cache ${cacheKey}:`, parseError);
          await redis.del(cacheKey);
        }
      } else {
        console.info(`[Cache Roster] MISS ${cacheKey}`);
      }
    } catch (redisError) {
      console.error(`[Cache Roster] Erro leitura Redis ${cacheKey}:`, redisError);
    }
  }

  console.time("[Tool Exec Roster Parallel Fetch]");
  const results = await Promise.allSettled([ _fetchHltvRoster(), _fetchLiquipediaRoster() ]);
  console.timeEnd("[Tool Exec Roster Parallel Fetch]");

  let bestResult: RosterResult | null = null;
  const errors: string[] = [];

  const hltvResult = results[0];
  if (hltvResult.status === 'fulfilled' && hltvResult.value.playersInfo) { bestResult = hltvResult.value; console.info(`[Tool Exec Roster] Usando resultado HLTV.`); }
  else if (hltvResult.status === 'fulfilled' && hltvResult.value.error) { errors.push(`HLTV: ${hltvResult.value.error}`); }
  else if (hltvResult.status === 'rejected') { errors.push(`HLTV Rejected: ${hltvResult.reason}`); }

  if (!bestResult) {
    const liquipediaResult = results[1];
    if (liquipediaResult.status === 'fulfilled' && liquipediaResult.value.playersInfo) { bestResult = liquipediaResult.value; console.info(`[Tool Exec Roster] Usando resultado Liquipedia.`); }
    else if (liquipediaResult.status === 'fulfilled' && liquipediaResult.value.error) { errors.push(`Liquipedia: ${liquipediaResult.value.error}`); }
    else if (liquipediaResult.status === 'rejected') { errors.push(`Liquipedia Rejected: ${liquipediaResult.reason}`); }
  }

  if (bestResult && bestResult.playersInfo) {
    if (redis) {
      try {
        const ttl = CACHE_TTL_SUCCESS_ROSTER;
        const dataToCache = JSON.stringify(bestResult); // Cacheia com source original
        console.time(`[Cache Roster Save ${cacheKey}]`);
        await redis.set(cacheKey, dataToCache, 'EX', ttl);
        console.timeEnd(`[Cache Roster Save ${cacheKey}]`);
        console.info(`[Cache Roster] SAVED OK ${cacheKey} (Fonte Original: ${bestResult.source}, TTL: ${ttl}s)`);
      } catch (e) { console.error(`[Cache Roster] SAVE ERR ${cacheKey}:`, e); }
    }
    const totalTime = Math.round(performance.now() - toolStartTime);
    console.info(`[Tool Exec Roster] Finalizado com SUCESSO em ${totalTime}ms.`);
    return { ...bestResult, fetchTimeMs: totalTime };
  } else {
    const finalError = `Falha ao buscar roster. Erros: [${errors.join('; ')}]`;
    console.error("[Tool Exec Roster] Finalizado com ERRO:", finalError);
    if (redis) {
      try {
        const errorData = JSON.stringify({ error: finalError });
        console.time(`[Cache Roster Save Error ${cacheKey}]`);
        await redis.set(cacheKey, errorData, 'EX', CACHE_TTL_ERROR);
        console.timeEnd(`[Cache Roster Save Error ${cacheKey}]`);
        console.info(`[Cache Roster] SAVED ERR ${cacheKey} (TTL: ${CACHE_TTL_ERROR}s)`);
      } catch(e) { console.error(`[Cache Roster] SAVE ERR (error case) ${cacheKey}:`, e);}
    }
    const totalTime = Math.round(performance.now() - toolStartTime);
    return { error: finalError, fetchTimeMs: totalTime };
  }
}

// --- Ferramenta Wikipedia ---
const wikipediaSearchSchema = z.object({ searchTerm: z.string() });
const wikipediaOutputSchema = z.object({ summary: z.string().optional(), error: z.string().optional(), source: z.enum(['api', 'Cache']).optional(), fetchTimeMs: z.number().optional() });
async function executeSearchWikipedia(input: z.infer<typeof wikipediaSearchSchema>): Promise<z.infer<typeof wikipediaOutputSchema>> {
  const toolStartTime = performance.now();
  const { searchTerm } = input;
  console.info(`[Tool Exec Wiki] Iniciando busca por '${searchTerm}'.`);
  const cacheKey = `wiki:${searchTerm.toLowerCase().replace(/\s+/g, '_')}`;

  if (redis) {
    try {
      console.time(`[Cache Wiki Read ${cacheKey}]`);
      const d = await redis.get(cacheKey);
      console.timeEnd(`[Cache Wiki Read ${cacheKey}]`);
      if (d) {
        try {
          const p = JSON.parse(d);
          const validationSchema = wikipediaOutputSchema.extend({ source: z.literal('api').optional() });
          const v = validationSchema.safeParse(p);
          if (v.success) {
            if (v.data.summary) { console.info(`[Cache Wiki] HIT ${searchTerm}`); return { ...v.data, source: 'Cache', fetchTimeMs: v.data.fetchTimeMs }; }
            if (v.data.error) console.warn(`[Cache Wiki] HIT com erro cacheado ${searchTerm}: ${v.data.error.substring(0,100)}...`);
          } else { console.warn(`[Cache Wiki] Dados inválidos ${searchTerm}`, v.error); await redis.del(cacheKey); }
        } catch (pE) { console.warn(`[Cache Wiki] parse err ${searchTerm}`, pE); await redis.del(cacheKey); }
      } else { console.info(`[Cache Wiki] MISS ${searchTerm}`); }
    } catch (e){ console.error(`[Cache Wiki] READ ERR ${searchTerm}`,e); }
  }

  let apiResult: z.infer<typeof wikipediaOutputSchema>;
  let fetchTimeMsApi = 0;
  let apiStartTime = performance.now(); // Initialize here
  try {
    apiStartTime = performance.now();
    console.time(`[Wiki API Fetch ${searchTerm}]`);
    wiki.setLang('pt');
    const page = await wiki.page(searchTerm, { autoSuggest: true });
    console.timeEnd(`[Wiki API Fetch ${searchTerm}]`);

    if (!page) { apiResult = { error: `Página '${searchTerm}' não encontrada na Wikipedia.` }; }
    else {
      console.time(`[Wiki API Summary ${searchTerm}]`);
      const summaryResult = await page.summary();
      console.timeEnd(`[Wiki API Summary ${searchTerm}]`);
      if (!summaryResult?.extract) { apiResult = { error: `Não foi possível obter um resumo para '${searchTerm}'.` }; }
      else {
        const MAX_SUMMARY_LENGTH = 1500; let txt = summaryResult.extract;
        if (txt.length > MAX_SUMMARY_LENGTH) { txt = txt.substring(0, MAX_SUMMARY_LENGTH) + "... (resumo truncado)"; console.info(`[Wiki API] Resumo truncado ${searchTerm}.`); }
        apiResult = { summary: txt, source: 'api' }; console.info(`[Wiki API] Resumo OK ${searchTerm}.`);
      }
    }
    fetchTimeMsApi = Math.round(performance.now() - apiStartTime);
  } catch (err) {
    try { console.timeEnd(`[Wiki API Fetch ${searchTerm}]`); } catch {} try { console.timeEnd(`[Wiki API Summary ${searchTerm}]`); } catch {}
    console.error(`[Wiki API] Erro ${searchTerm}:`, err);
    const msg = err instanceof Error ? err.message : "?"; let eMsg = `Erro ao buscar na Wikipedia: ${msg}`;
    if (String(err).includes('No article found') || String(err).includes('does not match') || String(err).includes('Not found.')) { eMsg = `Artigo '${searchTerm}' não encontrado na Wikipedia.`; }
    apiResult = { error: eMsg };
    fetchTimeMsApi = Math.round(performance.now() - apiStartTime); // Tempo até o erro
  }

  if (redis) {
    try {
      const ttl = apiResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS_WIKI;
      const dataToCache = JSON.stringify({ ...apiResult, fetchTimeMs: fetchTimeMsApi });
      console.time(`[Cache Wiki Save ${cacheKey}]`);
      await redis.set(cacheKey, dataToCache, 'EX', ttl);
      console.timeEnd(`[Cache Wiki Save ${cacheKey}]`);
      console.info(`[Cache Wiki] SAVED ${searchTerm} (TTL: ${ttl}s)`);
    } catch (e) { console.error(`[Cache Wiki] SAVE ERR ${searchTerm}`, e); }
  }
  const totalTime = Math.round(performance.now() - toolStartTime);
  console.info(`[Tool Exec Wiki] Finalizado para '${searchTerm}' em ${totalTime}ms.`);
  return {...apiResult, fetchTimeMs: totalTime };
}

// --- Ferramenta Próximas Partidas (RapidAPI) ---
const upcomingMatchesOutputSchema = z.object({ matchesInfo: z.string().optional(), error: z.string().optional(), source: z.enum(['RapidAPI', 'Cache']).optional(), fetchTimeMs: z.number().optional() });
async function executeGetFuriaUpcomingMatchesRapidAPI(): Promise<z.infer<typeof upcomingMatchesOutputSchema>> {
  const toolStartTime = performance.now();
  const sourceId = 'RapidAPI Upcoming';
  console.info(`[Tool Exec ${sourceId}] Iniciando...`);
  const cacheKey = "rapidapi:furia_upcoming_v2";
  if (!RAPIDAPI_KEY) return { error: "Chave da API (RapidAPI) não configurada.", fetchTimeMs: Math.round(performance.now()-toolStartTime) };

  if (redis) {
    try {
      console.time(`[Cache ${sourceId} Read ${cacheKey}]`);
      const d = await redis.get(cacheKey);
      console.timeEnd(`[Cache ${sourceId} Read ${cacheKey}]`);
      if (d) {
        try {
          const p = JSON.parse(d);
          const validationSchema = upcomingMatchesOutputSchema.extend({ source: z.literal('RapidAPI').optional() });
          const v = validationSchema.safeParse(p);
          if(v.success && v.data.matchesInfo){ console.info(`[Cache ${sourceId}] HIT ${cacheKey}`); return {...v.data, source: 'Cache', fetchTimeMs: v.data.fetchTimeMs }; }
          if(v.success && v.data.error) console.warn(`[Cache ${sourceId}] HIT com erro cacheado ${cacheKey}`);
        } catch(pE){ await redis.del(cacheKey); console.warn(`[Cache ${sourceId}] Invalid cache ${cacheKey}`, pE); }
      } else { console.info(`[Cache ${sourceId}] MISS ${cacheKey}`);}
    } catch(e){ console.error(`[Cache ${sourceId}] Read Error ${cacheKey}:`, e); }
  }

  const options = { method: 'GET', url: `https://${RAPIDAPI_HOST}/api/esport/team/${FURIA_TEAM_ID}/matches/next/3`, headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST }, timeout: AXIOS_TIMEOUT_RAPIDAPI };
  let result: z.infer<typeof upcomingMatchesOutputSchema>;
  let apiFetchTime = 0;
  let apiStartTime = performance.now();
  try {
    apiStartTime = performance.now(); console.time(`[${sourceId} Fetch]`);
    const response = await axios.request(options);
    apiFetchTime = Math.round(performance.now() - apiStartTime); console.timeEnd(`[${sourceId} Fetch]`);
    const data = response.data; const events = data?.events ?? (Array.isArray(data) ? data : []);
    if (!Array.isArray(events) || events.length === 0) { result = { matchesInfo: "Nenhuma partida futura encontrada (API Principal)." }; }
    else {
      const matches = events.map((match: any) => {
        const opponent = match.awayTeam?.id?.toString() === FURIA_TEAM_ID ? match.homeTeam?.name : match.awayTeam?.name ?? '?';
        const tournament = match.tournament?.name ?? '?'; const timestamp = match.startTimestamp; let formattedDate = '?';
        if (timestamp) { try { formattedDate = new Date(timestamp * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) + ' (BRT)'; } catch (e) {} }
        return `vs ${opponent} (${tournament}) - ${formattedDate}`;
      }).filter(m => !m.includes('?'));
      result = { matchesInfo: matches.length > 0 ? matches.join('; ') : "Nenhuma partida futura com dados completos encontrada (API Principal)." };
    }
    console.info(`[${sourceId}] Sucesso (em ${apiFetchTime}ms):`, result.matchesInfo?.substring(0,100));
    result.source = 'RapidAPI';
  } catch (error: any) {
    if (apiFetchTime === 0) try {console.timeEnd(`[${sourceId} Fetch]`);} catch{}
    console.error(`[${sourceId}] Erro Fetch:`, error.response?.status, error.message, error.code);
    let errorMsg = `Falha API ${sourceId} (${error.code || error.response?.status || '?'}).`;
    if (error.response?.status === 429) errorMsg = "Limite da API Principal atingido.";
    else if (error.response?.status === 403) errorMsg = "Acesso negado à API Principal.";
    else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) errorMsg = "Timeout da API Principal.";
    result = { error: errorMsg };
    apiFetchTime = Math.round(performance.now() - apiStartTime);
  }

  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS_MATCHES;
      const dataToCache = JSON.stringify({ ...result, fetchTimeMs: apiFetchTime });
      console.time(`[Cache ${sourceId} Save ${cacheKey}]`);
      await redis.set(cacheKey, dataToCache, 'EX', ttl);
      console.timeEnd(`[Cache ${sourceId} Save ${cacheKey}]`);
      console.info(`[Cache ${sourceId}] SAVED ${cacheKey} (TTL: ${ttl}s)`);
    } catch (e) { console.error(`[Cache ${sourceId}] Save Err ${cacheKey}:`, e); }
  }

  const totalTime = Math.round(performance.now() - toolStartTime);
  console.info(`[Tool Exec ${sourceId}] Finalizado em ${totalTime}ms.`);
  return {...result, fetchTimeMs: totalTime };
}

// --- Ferramenta Resultados Recentes (RapidAPI) ---
const recentResultsOutputSchema = z.object({ resultsInfo: z.string().optional(), error: z.string().optional(), source: z.enum(['RapidAPI', 'Cache']).optional(), fetchTimeMs: z.number().optional() });
async function executeGetFuriaRecentResultsRapidAPI(): Promise<z.infer<typeof recentResultsOutputSchema>> {
  const toolStartTime = performance.now();
  const sourceId = 'RapidAPI Recent';
  console.info(`[Tool Exec ${sourceId}] Iniciando...`);
  const cacheKey = "rapidapi:furia_recent_v2";
  if (!RAPIDAPI_KEY) return { error: "Chave da API (RapidAPI) não configurada.", fetchTimeMs: Math.round(performance.now()-toolStartTime) };

  if (redis) {
    try {
      console.time(`[Cache ${sourceId} Read ${cacheKey}]`);
      const d = await redis.get(cacheKey);
      console.timeEnd(`[Cache ${sourceId} Read ${cacheKey}]`);
      if (d) {
        try {
          const p = JSON.parse(d);
          const validationSchema = recentResultsOutputSchema.extend({ source: z.literal('RapidAPI').optional() });
          const v = validationSchema.safeParse(p);
          if(v.success && v.data.resultsInfo){ console.info(`[Cache ${sourceId}] HIT ${cacheKey}`); return {...v.data, source: 'Cache', fetchTimeMs: v.data.fetchTimeMs }; }
          if(v.success && v.data.error) console.warn(`[Cache ${sourceId}] HIT com erro cacheado ${cacheKey}`);
        } catch(pE){ await redis.del(cacheKey); console.warn(`[Cache ${sourceId}] Invalid cache ${cacheKey}`, pE); }
      } else { console.info(`[Cache ${sourceId}] MISS ${cacheKey}`);}
    } catch(e){ console.error(`[Cache ${sourceId}] Read Error ${cacheKey}:`, e); }
  }

  const options = { method: 'GET', url: `https://${RAPIDAPI_HOST}/api/esport/team/${FURIA_TEAM_ID}/matches/last/5`, headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST }, timeout: AXIOS_TIMEOUT_RAPIDAPI };
  let result: z.infer<typeof recentResultsOutputSchema>;
  let apiFetchTime = 0;
  let apiStartTime = performance.now();
  try {
    apiStartTime = performance.now(); console.time(`[${sourceId} Fetch]`);
    const response = await axios.request(options);
    apiFetchTime = Math.round(performance.now() - apiStartTime); console.timeEnd(`[${sourceId} Fetch]`);
    const data = response.data; const events = data?.events ?? (Array.isArray(data) ? data : []);
    if (!Array.isArray(events) || events.length === 0) { result = { resultsInfo: "Nenhum resultado recente encontrado (API Principal)." }; }
    else {
      const results = events.map((match: any) => {
        const homeTeam = match.homeTeam; const awayTeam = match.awayTeam; const homeScore = match.homeScore?.display ?? match.homeScore?.current ?? '?'; const awayScore = match.awayScore?.display ?? match.awayScore?.current ?? '?'; const tournament = match.tournament?.name ?? '?'; const winnerCode = match.winnerCode;
        let opponent = '?'; let fScore = '?'; let oScore = '?'; let outcome = '';
        if (homeTeam?.id?.toString() === FURIA_TEAM_ID) { opponent = awayTeam?.name ?? '?'; fScore = homeScore; oScore = awayScore; if (winnerCode === 1) outcome = 'W'; else if (winnerCode === 2) outcome = 'L'; else if (winnerCode === 3) outcome = 'D';}
        else if (awayTeam?.id?.toString() === FURIA_TEAM_ID) { opponent = homeTeam?.name ?? '?'; fScore = awayScore; oScore = homeScore; if (winnerCode === 2) outcome = 'W'; else if (winnerCode === 1) outcome = 'L'; else if (winnerCode === 3) outcome = 'D'; }
        else { console.warn(`[${sourceId}] FURIA ID ${FURIA_TEAM_ID} não encontrado.`); opponent = `${homeTeam?.name ?? '?'} vs ${awayTeam?.name ?? '?'}`; }
        const scoreStr = (outcome && fScore !== '?' && oScore !== '?') ? `(${outcome} ${fScore}-${oScore})` : '(Placar Indisponível)';
        return `vs ${opponent} ${scoreStr} (${tournament})`;
      }).filter(r => !r.includes("vs ?"));
      result = { resultsInfo: results.length > 0 ? results.join('; ') : "Nenhum resultado recente válido encontrado (API Principal)." };
    }
    console.info(`[${sourceId}] Sucesso (em ${apiFetchTime}ms):`, result.resultsInfo?.substring(0,100));
    result.source = 'RapidAPI';
  } catch (error: any) {
    if (apiFetchTime === 0) try {console.timeEnd(`[${sourceId} Fetch]`);} catch{}
    console.error(`[${sourceId}] Erro Fetch:`, error.response?.status, error.message, error.code);
    let errorMsg = `Falha API ${sourceId} (${error.code || error.response?.status || '?'}).`;
    if (error.response?.status === 429) errorMsg = "Limite da API Principal atingido.";
    else if (error.response?.status === 403) errorMsg = "Acesso negado à API Principal.";
    else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) errorMsg = "Timeout da API Principal.";
    result = { error: errorMsg };
    apiFetchTime = Math.round(performance.now() - apiStartTime);
  }

  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS_RESULTS;
      const dataToCache = JSON.stringify({ ...result, fetchTimeMs: apiFetchTime });
      console.time(`[Cache ${sourceId} Save ${cacheKey}]`);
      await redis.set(cacheKey, dataToCache, 'EX', ttl);
      console.timeEnd(`[Cache ${sourceId} Save ${cacheKey}]`);
      console.info(`[Cache ${sourceId}] SAVED ${cacheKey} (TTL: ${ttl}s)`);
    } catch (e) { console.error(`[Cache ${sourceId}] Save Err ${cacheKey}:`, e); }
  }

  const totalTime = Math.round(performance.now() - toolStartTime);
  console.info(`[Tool Exec ${sourceId}] Finalizado em ${totalTime}ms.`);
  return {...result, fetchTimeMs: totalTime };
}

// --- Ferramenta Próximas Partidas (Liquipedia Scraper - Backup) ---
const upcomingMatchesLiquipediaOutputSchema = z.object({ matchesInfo: z.string().optional(), error: z.string().optional(), source: z.enum(['Liquipedia', 'Cache']).optional(), fetchTimeMs: z.number().optional() });
async function executeGetFuriaUpcomingMatchesLiquipedia(): Promise<z.infer<typeof upcomingMatchesLiquipediaOutputSchema>> {
  const toolStartTime = performance.now();
  const sourceId = 'Liquipedia Upcoming';
  console.info(`[Tool Exec ${sourceId}] Iniciando...`);
  const cacheKey = "liquipedia:furia_upcoming_v2";

  if (redis) {
    try {
      console.time(`[Cache ${sourceId} Read ${cacheKey}]`);
      const d = await redis.get(cacheKey);
      console.timeEnd(`[Cache ${sourceId} Read ${cacheKey}]`);
      if (d) {
        try {
          const p = JSON.parse(d);
          const validationSchema = upcomingMatchesLiquipediaOutputSchema.extend({ source: z.literal('Liquipedia').optional() });
          const v = validationSchema.safeParse(p);
          if(v.success && v.data.matchesInfo){ console.info(`[Cache ${sourceId}] HIT ${cacheKey}`); return {...v.data, source: 'Cache', fetchTimeMs: v.data.fetchTimeMs }; }
          if(v.success && v.data.error) console.warn(`[Cache ${sourceId}] HIT com erro cacheado ${cacheKey}`);
        } catch(pE){ await redis.del(cacheKey); console.warn(`[Cache ${sourceId}] Invalid cache ${cacheKey}`, pE); }
      } else { console.info(`[Cache ${sourceId}] MISS ${cacheKey}`);}
    } catch(e){ console.error(`[Cache ${sourceId}] Read Error ${cacheKey}:`, e); }
  }

  let result: z.infer<typeof upcomingMatchesLiquipediaOutputSchema>;
  let apiFetchTime = 0;
  let apiStartTime = performance.now();
  try {
    apiStartTime = performance.now();
    console.info(`[${sourceId}] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MAIN} (Upcoming)...`);
    console.time(`[${sourceId} Fetch]`);
    const response = await axios.get(LIQUIPEDIA_API_URL, { params: { action: 'parse', page: LIQUIPEDIA_PAGE_NAME_MAIN, prop: 'text', format: 'json', disabletoc: true }, headers: { 'User-Agent': CUSTOM_USER_AGENT }, timeout: AXIOS_TIMEOUT_LIQUIPEDIA });
    apiFetchTime = Math.round(performance.now() - apiStartTime);
    console.timeEnd(`[${sourceId} Fetch]`);

    if (response.data?.error) throw new Error(`API Liquipedia erro: ${response.data.error.info}`);
    const htmlContent = response.data?.parse?.text?.['*']; if (!htmlContent) throw new Error("HTML Liquipedia não encontrado.");
    const $ = cheerio.load(htmlContent); const matches: string[] = [];
    $('div.fo-nttax-infobox table.infobox_matches_content').first().find('tbody tr').each((_idx, row) => {
      if (matches.length >= 3) return false;
      const $row = $(row); const opponentDiv = $row.find('td').eq(0); const opponentName = opponentDiv.find('.team-template-text a').attr('title') || opponentDiv.text().trim() || '?';
      const tournamentLink = $row.find('td div[style*="text-align:center"] a').first(); const tournamentName = tournamentLink.attr('title') || tournamentLink.text().trim() || '?';
      const dateTimeElement = $row.find('.timer-object').first(); const dateTimeText = dateTimeElement.text().trim(); const timestamp = dateTimeElement.data('timestamp');
      let formattedDate = '?';
      if (timestamp && !isNaN(Number(timestamp))) { try { formattedDate = new Date(Number(timestamp) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) + ' (BRT)'; } catch (e) {} }
      else if (dateTimeText && !dateTimeText.toLowerCase().includes('tbd')) { try { formattedDate = dateTimeText + ' (Liquipedia Text - Timezone Unknown)'; } catch(e) {} }
      if (opponentName !== '?' && tournamentName !== '?' && formattedDate !== '?') { matches.push(`vs ${opponentName} (${tournamentName}) - ${formattedDate}`); }
    });
    if (matches.length > 0) { result = { matchesInfo: matches.join('; ') }; } else { result = { matchesInfo: "Nenhuma partida futura encontrada (Liquipedia Scraper)." }; }
    console.info(`[${sourceId}] Sucesso (em ${apiFetchTime}ms):`, result.matchesInfo?.substring(0,100));
    result.source = 'Liquipedia';
  } catch (error: any) {
    if (apiFetchTime === 0) try {console.timeEnd(`[${sourceId} Fetch]`);} catch{}
    console.error(`[${sourceId}] Erro Scraper:`, error.message, error.code);
    result = { error: `Falha ${sourceId}: ${error.message}` };
    apiFetchTime = Math.round(performance.now() - apiStartTime);
  }

  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS_MATCHES;
      const dataToCache = JSON.stringify({ ...result, fetchTimeMs: apiFetchTime });
      console.time(`[Cache ${sourceId} Save ${cacheKey}]`);
      await redis.set(cacheKey, dataToCache, 'EX', ttl);
      console.timeEnd(`[Cache ${sourceId} Save ${cacheKey}]`);
      console.info(`[Cache ${sourceId}] SAVED ${cacheKey} (TTL: ${ttl}s)`);
    } catch (e) { console.error(`[Cache ${sourceId}] Save Err ${cacheKey}:`, e); }
  }

  const totalTime = Math.round(performance.now() - toolStartTime);
  console.info(`[Tool Exec ${sourceId}] Finalizado em ${totalTime}ms.`);
  return {...result, fetchTimeMs: totalTime };
}

// --- Ferramenta Resultados Recentes (Liquipedia Scraper - Backup) ---
const recentResultsLiquipediaOutputSchema = z.object({ resultsInfo: z.string().optional(), error: z.string().optional(), source: z.enum(['Liquipedia', 'Cache']).optional(), fetchTimeMs: z.number().optional() });
async function executeGetFuriaRecentResultsLiquipedia(): Promise<z.infer<typeof recentResultsLiquipediaOutputSchema>> {
  const toolStartTime = performance.now();
  const sourceId = 'Liquipedia Recent';
  console.info(`[Tool Exec ${sourceId}] Iniciando...`);
  const cacheKey = "liquipedia:furia_recent_v2";

  if (redis) {
    try {
      console.time(`[Cache ${sourceId} Read ${cacheKey}]`);
      const d = await redis.get(cacheKey);
      console.timeEnd(`[Cache ${sourceId} Read ${cacheKey}]`);
      if (d) {
        try {
          const p = JSON.parse(d);
          const validationSchema = recentResultsLiquipediaOutputSchema.extend({ source: z.literal('Liquipedia').optional() });
          const v = validationSchema.safeParse(p);
          if(v.success && v.data.resultsInfo){ console.info(`[Cache ${sourceId}] HIT ${cacheKey}`); return {...v.data, source: 'Cache', fetchTimeMs: v.data.fetchTimeMs }; }
          if(v.success && v.data.error) console.warn(`[Cache ${sourceId}] HIT com erro cacheado ${cacheKey}`);
        } catch(pE){ await redis.del(cacheKey); console.warn(`[Cache ${sourceId}] Invalid cache ${cacheKey}`, pE); }
      } else { console.info(`[Cache ${sourceId}] MISS ${cacheKey}`);}
    } catch(e){ console.error(`[Cache ${sourceId}] Read Error ${cacheKey}:`, e); }
  }

  let result: z.infer<typeof recentResultsLiquipediaOutputSchema>;
  let apiFetchTime = 0;
  let apiStartTime = performance.now();
  try {
    apiStartTime = performance.now();
    console.info(`[${sourceId}] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MATCHES} (Recent)...`);
    console.time(`[${sourceId} Fetch]`);
    const response = await axios.get(LIQUIPEDIA_API_URL, { params: { action: 'parse', page: LIQUIPEDIA_PAGE_NAME_MATCHES, prop: 'text', format: 'json', disabletoc: true }, headers: { 'User-Agent': CUSTOM_USER_AGENT }, timeout: AXIOS_TIMEOUT_LIQUIPEDIA });
    apiFetchTime = Math.round(performance.now() - apiStartTime);
    console.timeEnd(`[${sourceId} Fetch]`);

    if (response.data?.error) throw new Error(`API Liquipedia erro: ${response.data.error.info}`);
    const htmlContent = response.data?.parse?.text?.['*']; if (!htmlContent) throw new Error("HTML Liquipedia não encontrado.");
    const $ = cheerio.load(htmlContent); const results: string[] = [];
    $('.wikitable.recent-matches tbody tr').slice(0, 7).each((_i, el) => {
      if (results.length >= 5) return false;
      const $row = $(el); const cells = $row.find('td'); if (cells.length < 5) return;
      const opponentTeamCell = $(cells[2]); const opponentName = opponentTeamCell.find('.team-template-text a').first().text().trim() || opponentTeamCell.text().trim() || '?';
      const scoreCell = $(cells[1]); const scoreText = scoreCell.text().trim().replace(/\s/g, '');
      let outcome = '?'; let furiaScore = '?'; let opponentScore = '?';
      if (scoreText.includes(':')) {
        const scores = scoreText.split(':');
        if (scores.length === 2 && !isNaN(parseInt(scores[0])) && !isNaN(parseInt(scores[1]))) {
          if ($(cells[0]).hasClass('match-won')) { outcome = 'W'; furiaScore = scores[0]; opponentScore = scores[1]; }
          else { outcome = 'L'; furiaScore = scores[0]; opponentScore = scores[1]; }
        }
      }
      const tournamentCell = $(cells[4]); const tournamentName = tournamentCell.find('a').first().attr('title') || tournamentCell.find('a').first().text().trim() || '?';
      if (opponentName !== '?' && outcome !== '?' && tournamentName !== '?') { results.push(`vs ${opponentName} (${outcome} ${furiaScore}:${opponentScore}) (${tournamentName})`); }
    });
    if (results.length > 0) { result = { resultsInfo: results.join('; ') }; } else { result = { resultsInfo: "Nenhum resultado recente encontrado (Liquipedia Scraper)." }; }
    console.info(`[${sourceId}] Sucesso (em ${apiFetchTime}ms):`, result.resultsInfo?.substring(0,100));
    result.source = 'Liquipedia';
  } catch (error: any) {
    if (apiFetchTime === 0) try {console.timeEnd(`[${sourceId} Fetch]`);} catch{}
    console.error(`[${sourceId}] Erro Scraper:`, error.message);
    result = { error: `Falha ${sourceId}: ${error.message}` };
    apiFetchTime = Math.round(performance.now() - apiStartTime);
  }

  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS_RESULTS;
      const dataToCache = JSON.stringify({ ...result, fetchTimeMs: apiFetchTime });
      console.time(`[Cache ${sourceId} Save ${cacheKey}]`);
      await redis.set(cacheKey, dataToCache, 'EX', ttl);
      console.timeEnd(`[Cache ${sourceId} Save ${cacheKey}]`);
      console.info(`[Cache ${sourceId}] SAVED ${cacheKey} (TTL: ${ttl}s)`);
    } catch (e) { console.error(`[Cache ${sourceId}] Save Err ${cacheKey}:`, e); }
  }

  const totalTime = Math.round(performance.now() - toolStartTime);
  console.info(`[Tool Exec ${sourceId}] Finalizado em ${totalTime}ms.`);
  return {...result, fetchTimeMs: totalTime };
}

// --- Ferramenta Notícias HLTV RSS ---
const hltvNewsOutputSchema = z.object({ newsInfo: z.string().optional(), error: z.string().optional(), source: z.enum(['HLTV-RSS', 'Cache']).optional(), fetchTimeMs: z.number().optional() });
const rssParser = new Parser({ timeout: RSS_TIMEOUT });
async function executeGetFuriaNewsHltv(): Promise<z.infer<typeof hltvNewsOutputSchema>> {
  const toolStartTime = performance.now();
  const sourceId = 'HLTV News RSS';
  console.info(`[Tool Exec ${sourceId}] Iniciando...`);
  const cacheKey = "hltv:rss_news_furia_v2";

  if (redis) {
    try {
      console.time(`[Cache ${sourceId} Read ${cacheKey}]`);
      const d = await redis.get(cacheKey);
      console.timeEnd(`[Cache ${sourceId} Read ${cacheKey}]`);
      if (d) {
        try {
          const p = JSON.parse(d);
          const validationSchema = hltvNewsOutputSchema.extend({ source: z.literal('HLTV-RSS').optional() });
          const v = validationSchema.safeParse(p);
          if(v.success && v.data.newsInfo){ console.info(`[Cache ${sourceId}] HIT ${cacheKey}`); return {...v.data, source: 'Cache', fetchTimeMs: v.data.fetchTimeMs }; }
          if(v.success && v.data.error) console.warn(`[Cache ${sourceId}] HIT com erro cacheado ${cacheKey}`);
        } catch(pE){ await redis.del(cacheKey); console.warn(`[Cache ${sourceId}] Invalid cache ${cacheKey}`, pE); }
      } else { console.info(`[Cache ${sourceId}] MISS ${cacheKey}`);}
    } catch(e){ console.error(`[Cache ${sourceId}] Read Error ${cacheKey}:`, e); }
  }

  let result: z.infer<typeof hltvNewsOutputSchema>;
  let apiFetchTime = 0;
  let apiStartTime = performance.now();
  try {
    apiStartTime = performance.now();
    console.info(`[${sourceId}] Buscando feed: ${HLTV_RSS_NEWS_URL}`);
    console.time(`[${sourceId} Fetch]`);
    // @ts-ignore - Tipos do rss-parser podem não ser perfeitos
    const feed = await rssParser.parseURL(HLTV_RSS_NEWS_URL);
    apiFetchTime = Math.round(performance.now() - apiStartTime);
    console.timeEnd(`[${sourceId} Fetch]`);

    if (!feed?.items?.length) { throw new Error("Feed RSS vazio ou inválido HLTV."); }
    const furiaNews: string[] = [];
    console.info(`[${sourceId}] Processando ${feed.items.length} itens do feed...`);
    for (const item of feed.items) {
      if (furiaNews.length >= 5) break;
      const title = item.title?.toLowerCase() || '';
      const isRelevant = NEWS_FILTER_TERMS.some(term => title.includes(term));
      if (isRelevant && item.title && item.link) { const cleanTitle = item.title.replace(/<[^>]*>?/gm, '').trim(); furiaNews.push(`${cleanTitle}: ${item.link}`); }
    }
    if (furiaNews.length > 0) { result = { newsInfo: furiaNews.join('; ') }; } else { result = { newsInfo: "Nenhuma notícia recente sobre a FURIA encontrada no feed da HLTV." }; }
    console.info(`[${sourceId}] Sucesso (em ${apiFetchTime}ms):`, result.newsInfo?.substring(0,100));
    result.source = 'HLTV-RSS';
  } catch (error: any) {
    if (apiFetchTime === 0) try {console.timeEnd(`[${sourceId} Fetch]`);} catch{}
    console.error(`[${sourceId}] Erro ao buscar ou processar feed:`, error.message);
    result = { error: `Falha ao buscar notícias HLTV: ${error.message}` };
    apiFetchTime = Math.round(performance.now() - apiStartTime);
  }

  if (redis) {
    try {
      const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS_NEWS;
      const dataToCache = JSON.stringify({ ...result, fetchTimeMs: apiFetchTime });
      console.time(`[Cache ${sourceId} Save ${cacheKey}]`);
      await redis.set(cacheKey, dataToCache, 'EX', ttl);
      console.timeEnd(`[Cache ${sourceId} Save ${cacheKey}]`);
      console.info(`[Cache ${sourceId}] SAVED ${cacheKey} (TTL: ${ttl}s)`);
    } catch (e) { console.error(`[Cache ${sourceId}] Save Err ${cacheKey}:`, e); }
  }

  const totalTime = Math.round(performance.now() - toolStartTime);
  console.info(`[Tool Exec ${sourceId}] Finalizado em ${totalTime}ms.`);
  return {...result, fetchTimeMs: totalTime };
}

// --- Registro das Ferramentas ---
interface ToolDefinition<I extends ZodTypeAny, O extends ZodTypeAny> { name: string; description: string; inputSchema: I; outputSchema: O; }
const toolDefinitions = new Map<string, ToolDefinition<any, any>>();
const activeTools: ToolAction[] = [];
function registerToolAction<I extends ZodTypeAny, O extends ZodTypeAny>(
  definition: ToolDefinition<I, O>, executor: (input: z.infer<I>) => Promise<z.infer<O>>
): ToolAction<I, O> {
  toolDefinitions.set(definition.name, definition);
  const toolAction = ai.defineTool(definition, executor);
  activeTools.push(toolAction);
  console.info(`[Init] Ferramenta registrada: ${definition.name}`);
  return toolAction;
}

// Registrar todas as ferramentas e guardar constantes
const getFuriaRosterTool = registerToolAction( { name: "getFuriaRoster", description: "Busca a escalação ATUAL da FURIA CS2 (Fontes: HLTV e Liquipedia). SEMPRE use esta ferramenta para perguntas sobre o elenco.", inputSchema: z.object({}), outputSchema: rosterResultSchema }, executeGetFuriaRoster );
const searchWikipediaTool = registerToolAction( { name: "searchWikipedia", description: "Busca um resumo na Wikipedia (jogador, time, evento). Use SEMPRE para perguntas sobre pessoas específicas.", inputSchema: wikipediaSearchSchema, outputSchema: wikipediaOutputSchema }, executeSearchWikipedia );
const getFuriaUpcomingMatchesRapidAPITool = registerToolAction( { name: "getFuriaUpcomingMatchesRapidAPI", description: "Busca as próximas 3 partidas da FURIA CS2 (Fonte: API Externa Principal). Use esta ferramenta OBRIGATORIAMENTE para próximos jogos.", inputSchema: z.object({}), outputSchema: upcomingMatchesOutputSchema }, executeGetFuriaUpcomingMatchesRapidAPI );
const getFuriaRecentResultsRapidAPITool = registerToolAction( { name: "getFuriaRecentResultsRapidAPI", description: "Busca os 5 resultados mais recentes da FURIA CS2 (Fonte: API Externa Principal). Use esta ferramenta OBRIGATORIAMENTE para resultados.", inputSchema: z.object({}), outputSchema: recentResultsOutputSchema }, executeGetFuriaRecentResultsRapidAPI );
const getFuriaUpcomingMatchesLiquipediaTool = registerToolAction( { name: "getFuriaUpcomingMatchesLiquipedia", description: "Busca as próximas 3 partidas da FURIA CS2 (Fonte: Liquipedia Scraper - usar como backup se a API principal falhar).", inputSchema: z.object({}), outputSchema: upcomingMatchesLiquipediaOutputSchema }, executeGetFuriaUpcomingMatchesLiquipedia );
const getFuriaRecentResultsLiquipediaTool = registerToolAction( { name: "getFuriaRecentResultsLiquipedia", description: "Busca os 5 resultados mais recentes da FURIA CS2 (Fonte: Liquipedia Scraper - usar como backup se a API principal falhar).", inputSchema: z.object({}), outputSchema: recentResultsLiquipediaOutputSchema }, executeGetFuriaRecentResultsLiquipedia );
const getFuriaNewsHltvTool = registerToolAction( { name: "getFuriaNewsHltv", description: "Busca as 5 notícias mais recentes sobre a FURIA no feed RSS da HLTV. Use para perguntas sobre notícias ou novidades.", inputSchema: z.object({}), outputSchema: hltvNewsOutputSchema }, executeGetFuriaNewsHltv );
console.info(`[Init] Total de Ferramentas Genkit ATIVAS: ${activeTools.length}`);


// --- Definição do Flow Principal do Chat ---
const flowInputSchema = z.object({
  userMessage: z.string(),
  chatHistory: z.array(z.any()).optional().default([]),
  chatId: z.number().optional(),
});
const furiaChatFlow = defineFlow(
  { name: "furiaChatFlow", inputSchema: flowInputSchema, outputSchema: z.string().describe("Resposta final do assistente para o usuário"), },
  async (input): Promise<string> => {
    const flowStartTime = performance.now();
    const { userMessage, chatHistory, chatId } = input;
    const logPrefix = chatId ? `[Flow Chat ${chatId}]` : "[Flow]";
    console.info(`${logPrefix} Start | Mensagem: "${userMessage.substring(0,50)}..." | Histórico: ${chatHistory.length} msgs`);

    const validHistory: MessageData[] = chatHistory
      .map((msg: any): MessageData | null => { // Adicionado tipo de retorno explícito
        if (msg && typeof msg.role === 'string' && Array.isArray(msg.content) &&
          msg.content.every((part: any) => typeof part.text === 'string' || part.toolRequest || part.toolResponse)) {
          if(msg.content[0]?.text && msg.content[0].text.length > 2000) {
            console.warn(`${logPrefix} Mensagem longa no histórico truncada: Role ${msg.role}`);
            msg.content[0].text = msg.content[0].text.substring(0, 2000) + "... (truncado)";
          }
          return msg as MessageData;
        }
        console.warn(`${logPrefix} Msg inválida removida do histórico:`, JSON.stringify(msg).substring(0,100));
        return null;
      })
      .filter((msg): msg is MessageData => msg !== null);

    const currentHistory: MessageData[] = [...validHistory];
    currentHistory.push({ role: 'user', content: [{ text: userMessage }] });
    const MAX_FLOW_HISTORY_MESSAGES = 8;
    while (currentHistory.length > MAX_FLOW_HISTORY_MESSAGES) { currentHistory.shift(); }
    console.info(`${logPrefix} Histórico antes da IA (após adição/trim): ${currentHistory.length} msgs`);

    const systemInstruction = `Você é FURIOSO, o assistente virtual oficial e super fã da FURIA Esports! Sua missão é ajudar a galera com informações precisas e atualizadas sobre nosso time de CS2, sempre com muito entusiasmo! Lembre-se do nosso papo anterior pra gente continuar na mesma página! 😉
        - **Tom:** Responda sempre em português do Brasil, com um tom amigável, caloroso, um pouco brincalhão e MUITO apaixonado pela FURIA! Mostre empolgação! Use exclamações! Uma gíria gamer leve (rushar, na mira!) cai bem de vez em quando, mas sem exagero. Ex: "Que demais essa pergunta!", "Boa, consegui achar aqui pra você! 🎉".
        - **Emojis:** Use emojis para deixar a conversa mais animada e com a cara da FURIA! 🐾🔥🏆🔫🥳🎉 Mas use com moderação, viu?
        - **Persona:** Você faz parte da família FURIA! Use "nós", "nosso time", "nossa pantera". Preste atenção no histórico da conversa para dar respostas mais relevantes e evitar repetições.
        - **Foco TOTAL:** Sua especialidade é a FURIA CS2. Responda **SOMENTE** sobre nossos jogadores, coach, staff, partidas, história e notícias relacionadas. Qualquer pergunta fora disso, responda educadamente no seu estilo: "Opa! Meu negócio é FURIA na veia! 🐾 Sobre outros times não consigo te ajudar agora, beleza? Mas se quiser saber algo da nossa pantera, manda bala!". Não dê opiniões sobre performance ou conselhos de aposta.

        - **<<< REGRA CRÍTICA DE FERRAMENTAS >>>**
            - Você **DEVE** usar as ferramentas certas para buscar informações atualizadas. Aja como se você soubesse a informação após usar a ferramenta.
            - **Escalação ATUAL?** Chame OBRIGATORIAMENTE 'getFuriaRoster'. A informação da ferramenta SEMPRE sobrepõe o que você 'lembra'.
            - **Próximos Jogos?**
                - **REGRA INDISPENSÁVEL:** Se a pergunta for sobre próximos jogos, **CHAME PRIMEIRO** a ferramenta 'getFuriaUpcomingMatchesRapidAPI'.
                - Se a ferramenta principal falhar (retornar erro), **PODE** tentar chamar 'getFuriaUpcomingMatchesLiquipedia' como backup.
                - **NUNCA** responda sobre próximos jogos sem antes TENTAR usar 'getFuriaUpcomingMatchesRapidAPI'.
            - **Resultados Recentes?**
                - **REGRA INDISPENSÁVEL:** Se a pergunta for sobre resultados recentes, **CHAME PRIMEIRO** a ferramenta 'getFuriaRecentResultsRapidAPI'.
                - Se a ferramenta principal falhar (retornar erro), **PODE** tentar chamar 'getFuriaRecentResultsLiquipedia' como backup.
                 - **NUNCA** responda sobre resultados recentes sem antes TENTAR usar 'getFuriaRecentResultsRapidAPI'.
            - **Notícias/Novidades?** Chame OBRIGATORIAMENTE 'getFuriaNewsHltv'.
            - **Alguém Específico (Jogador/Coach/Staff/Personalidade)?** Chame OBRIGATORIAMENTE 'searchWikipedia'.
            - **Outros Tópicos (Torneios, Conceitos CS)?** Use 'searchWikipedia'.

        - **Como Responder (O mais importante!):**
            - **SEM METALINGUAGEM!** NUNCA, JAMAIS, em hipótese alguma, mencione que você "usou uma ferramenta", "buscou na API", "pesquisou na Wikipedia", "verifiquei minhas fontes", etc. Apresente o resultado DIRETAMENTE! Ex: Se a ferramenta retornou 'vs NAVI...', diga "O próximo jogo é contra a NAVI...".
            - **Sintetize Dados de Jogos/Notícias:** Se receber info de múltiplas fontes (ex: API principal e backup), combine-as se forem complementares. Se forem diferentes, apresente a informação mais provável (API principal) e talvez mencione a outra como alternativa, mas sem dizer "a API X disse..." ou "o scraper Y mostrou...". Ex: "Achei aqui que o jogo é dia 10 às 14h! Também vi uma menção ao dia 11, mas a data mais certa parece ser dia 10. Fica ligado! 😉".
            - **VARIE!** Use saudações diferentes, formas diferentes de apresentar a info.
            - **SEMPRE ENGAGE!** Tente terminar sua resposta com uma pergunta para manter o papo rolando! Ex: "Quer saber mais algum detalhe sobre ele?", "Posso te ajudar com outro jogador ou campeonato?", "Curtiu a info? Quer saber de mais alguém?", "Algo mais que posso te ajudar sobre a nossa pantera?".

        - **Lidando com Falhas (Acontece! 😅):**
            - Se as ferramentas OBRIGATÓRIAS falharem (retornarem erro) ou não encontrarem NADA (retornarem "não encontrado"): informe que não conseguiu a informação específica NO MOMENTO e sugira verificar fontes oficiais (HLTV, site/redes da FURIA). Seja leve! Ex: "Putz, não achei essa info de jogo aqui agora! 😥 Dá uma conferida no HLTV ou nas redes da FURIA pra ter certeza 😉" ou "Xiii, minhas fontes tão offline pra essa info... 🔮 Melhor dar uma olhada nas redes oficiais da Pantera!". NUNCA invente dados! #GoFURIA`;

    const messagesForAI: MessageData[] = [{ role: 'system', content: [{ text: systemInstruction }] }, ...currentHistory];
    if (messagesForAI.length > 1 && !['user', 'tool'].includes(messagesForAI[messagesForAI.length - 1].role)) {
      console.error(`${logPrefix} ERRO CRÍTICO: Última mensagem antes da IA não é 'user' ou 'tool'. Era: ${messagesForAI[messagesForAI.length - 1].role}`);
      return "Eita! Parece que a ordem da nossa conversa ficou meio maluca aqui. 🤯 Pode mandar a pergunta de novo, por favor?";
    }
    console.info(`${logPrefix} AI Call Prep | Enviando ${messagesForAI.length} msgs...`);
    // console.debug(`${logPrefix} AI Call Full Context:`, JSON.stringify(messagesForAI));

    try {
      const toolsToUse = activeTools;
      console.time(`${logPrefix} AI Generate Call - Total`);
      let llmResponse: GenerateResponse;

      llmResponse = await ai.generate({ model: gemini15Flash, messages: messagesForAI, tools: toolsToUse, config: { temperature: 0.5 } });

      let attempts = 0;
      const MAX_TOOL_ATTEMPTS = 3;

      while (attempts < MAX_TOOL_ATTEMPTS) {
        console.timeEnd(`${logPrefix} AI Generate Call - Total`);
        const responseMessage = llmResponse.message;
        if (!responseMessage) { /* ... erro sem message ... */
          console.error(`${logPrefix} Resposta IA inválida (sem message):`, llmResponse);
          return "Opa! Tive um probleminha para processar a resposta aqui (no message). Pode tentar de novo? 🤔";
        }

        const responseText = llmResponse.text; // Acessar como propriedade

        if (!responseMessage.content || responseMessage.content.length === 0) { /* ... resposta sem content ... */
          console.warn(`${logPrefix} Resposta IA sem message.content, usando llmResponse.text`);
          if(responseText) {
            console.info(`${logPrefix} AI Response | Resposta final (sem tool use): "${responseText.substring(0, 100)}..."`);
            const flowEndTime = performance.now(); console.info(`${logPrefix} End | Tempo total: ${Math.round(flowEndTime - flowStartTime)}ms`);
            return responseText;
          } else {
            console.error(`${logPrefix} Resposta IA sem conteúdo e sem texto.`);
            return "Opa! Tive um probleminha para processar a resposta aqui (no content). Pode tentar de novo? 🤔";
          }
        }

        // <<< CORREÇÃO: Adicionar tipo Part >>>
        const toolRequestParts = responseMessage.content.filter((part: Part) => part.toolRequest);

        if (toolRequestParts.length === 0) { /* ... resposta final com content mas sem tool request ... */
          console.info(`${logPrefix} AI Response | Resposta final (sem mais ferramentas): "${responseText?.substring(0, 100)}..."`);
          if (!responseText || responseText.includes("CRASHEI!") || responseText.includes("Oloco!")) { return "Hmm, parece que me confundi aqui. Pode perguntar de novo?"; }
          const flowEndTime = performance.now(); console.info(`${logPrefix} End | Tempo total: ${Math.round(flowEndTime - flowStartTime)}ms`);
          return responseText;
        }

        attempts++;
        messagesForAI.push(responseMessage);
        // <<< CORREÇÃO: Adicionar tipo Part >>>
        console.info(`${logPrefix} Tool Request ${attempts}/${MAX_TOOL_ATTEMPTS} | IA solicitou: ${toolRequestParts.map((part: Part) => part.toolRequest!.name).join(', ')}`);

        console.time(`${logPrefix} Tool Execution Attempt ${attempts}`);
        // <<< CORREÇÃO: Adicionar tipo Part >>>
        const toolPromises = toolRequestParts.map(async (part: Part) => {
          const toolRequest = part.toolRequest; if (!toolRequest) return null;
          const toolName = toolRequest.name; const inputArgs = toolRequest.input; let output: any;
          const toolDefinition = toolDefinitions.get(toolName);
          let executor: Function | undefined;
          if(toolDefinition) {
            const executorMap: Record<string, Function> = {
              [getFuriaRosterTool.name]: executeGetFuriaRoster,
              [searchWikipediaTool.name]: executeSearchWikipedia,
              [getFuriaUpcomingMatchesRapidAPITool.name]: executeGetFuriaUpcomingMatchesRapidAPI,
              [getFuriaRecentResultsRapidAPITool.name]: executeGetFuriaRecentResultsRapidAPI,
              [getFuriaUpcomingMatchesLiquipediaTool.name]: executeGetFuriaUpcomingMatchesLiquipedia,
              [getFuriaRecentResultsLiquipediaTool.name]: executeGetFuriaRecentResultsLiquipedia,
              [getFuriaNewsHltvTool.name]: executeGetFuriaNewsHltv,
            };
            executor = executorMap[toolName];
          }
          if (executor && toolDefinition) {
            try {
              const parsedInput = toolDefinition.inputSchema.parse(inputArgs || {});
              console.info(`${logPrefix} Tool Start Exec | Executando ${toolName}... Input: ${JSON.stringify(parsedInput)}`);
              output = await executor(parsedInput);
              console.info(`${logPrefix} Tool End Exec | ${toolName} concluído. Output Summary: ${JSON.stringify(output).substring(0, 100)}...`);
            } catch (error) {
              if (error instanceof z.ZodError) { output = { error: `Input da IA inválido para ${toolName}: ${error.errors.map((e: ZodIssue) => e.message).join(', ')}` }; }
              else { output = { error: `Erro interno na ferramenta ${toolName}: ${error instanceof Error ? error.message : String(error)}` }; }
            }
          } else { output = { error: `Ferramenta '${toolName}' desconhecida ou desativada.` }; }
          return { role: 'tool', content: [{ toolResponse: { name: toolName, output: output } }] } as MessageData;
        });

        const resolvedResponses = await Promise.all(toolPromises);
        console.timeEnd(`${logPrefix} Tool Execution Attempt ${attempts}`);

        // <<< CORREÇÃO: Remover anotação ': null' >>>
        messagesForAI.push(...resolvedResponses.filter((r): r is MessageData => r !== null));

        console.info(`${logPrefix} AI Call ${attempts + 1} | Rechamando ai.generate com ${resolvedResponses.length} resposta(s) de ferramenta(s).`);
        console.time(`${logPrefix} AI Generate Call - Total`);
        llmResponse = await ai.generate({ model: gemini15Flash, messages: messagesForAI, tools: toolsToUse, config: { temperature: 0.5 } });
      } // Fim while

      console.warn(`${logPrefix} Limite de ${MAX_TOOL_ATTEMPTS} chamadas de ferramentas atingido.`);
      const lastTextFallback = llmResponse.text; // Usar propriedade
      const flowEndTimeLimit = performance.now(); console.info(`${logPrefix} End - Limit | Tempo total: ${Math.round(flowEndTimeLimit - flowStartTime)}ms`);
      if (lastTextFallback && !lastTextFallback.includes("CRASHEI!")) { return lastTextFallback + "\n\n(Psst: Parece que precisei de várias etapas pra te responder! 😅)"; }
      else { return "Eita, me enrolei um pouco com as informações aqui! 😵‍💫 Tenta perguntar de novo, talvez de forma mais direta?"; }

    } catch (error) {
      console.error(`${logPrefix} Erro fatal no Flow:`, error);
      const flowEndTimeError = performance.now(); console.info(`${logPrefix} End - Error | Tempo total: ${Math.round(flowEndTimeError - flowStartTime)}ms`);
      let errorDetailsFallback = String(error); if (error instanceof Error) { errorDetailsFallback = error.message; }
      return `CRASHEI FEIO! 💥 Deu ruim aqui nos meus circuitos (${errorDetailsFallback.substring(0,50)}...). Não consegui processar. Tenta de novo daqui a pouco, por favor? 🙏 #FAIL`;
    }
    // <<< CORREÇÃO: Adicionar retorno fallback >>>
    console.error(`${logPrefix} Atingiu o fim do fluxo sem retornar (erro inesperado).`);
    return "Desculpe, ocorreu um erro inesperado ao processar sua solicitação.";
  }
);
console.info("[Init] Flow Genkit 'furiaChatFlow' definido com lógica de ferramentas.");

// --- Função Helper para Formatar Resposta de Ferramenta ---
function formatToolResponseForUser(toolName: string, response: any): string {
  const startTime = performance.now();
  let reply = `Resultado de ${toolName}:\n`;
  if (!response) { reply += `Sem resposta da ferramenta. 😥`; }
  else if (response.error) { reply += `Ops! Tive um problema: ${response.error} 😥`; }
  else {
    // <<< CORREÇÃO: Usar string literals >>>
    switch (toolName) {
    case 'getFuriaRoster':
      reply += `Nosso elenco atual (${response.source || '?'}): ${response.playersInfo} 🔥`; break;
    case 'getFuriaUpcomingMatchesRapidAPI':
    case 'getFuriaUpcomingMatchesLiquipedia':
      if (response.matchesInfo?.startsWith("Nenhuma")) reply += `${response.matchesInfo} Fica ligado nas redes! 👀`;
      else reply += `Próximos jogos (${response.source || '?'}):\n- ${response.matchesInfo?.replace(/;\s*/g, '\n- ')}`; break;
    case 'getFuriaRecentResultsRapidAPI':
    case 'getFuriaRecentResultsLiquipedia':
      if (response.resultsInfo?.startsWith("Nenhuma")) reply += `${response.resultsInfo} Confere no HLTV que deve ter algo lá! 🤔`;
      else reply += `Resultados recentes (${response.source || '?'}):\n- ${response.resultsInfo?.replace(/;\s*/g, '\n- ')} 🏆`; break;
    case 'getFuriaNewsHltv':
      if (response.newsInfo?.startsWith("Nenhuma")) reply += `Não achei notícias fresquinhas da FURIA no feed da HLTV agora. 📰`;
      else reply += `Últimas notícias da HLTV:\n- ${response.newsInfo?.replace(/;\s*/g, '\n- ')} 📰`; break;
    case 'searchWikipedia':
      if(response.summary) reply += `Resumo da Wikipedia:\n ${response.summary}`;
      else reply += `Não achei um resumo na Wikipedia para isso.`; break;
    default: reply += JSON.stringify(response, null, 2);
    }
  }
  if(response?.fetchTimeMs) { reply += `\n(Busca levou ${response.fetchTimeMs}ms)`; }
  const endTime = performance.now();
  console.info(`[Format Helper] Formatado ${toolName} em ${Math.round(endTime-startTime)}ms`);
  return reply;
}

// --- Configuração do Servidor Express e Webhook com Comandos ---
const app = express(); app.use(express.json());
app.get('/', (_req, res) => { res.status(200).send('Servidor Bot Furia CS Ativo! Otimizado v5.'); });
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`;
console.info(`[Init] Configurando POST para webhook em: ${WEBHOOK_PATH}`);

app.post(WEBHOOK_PATH, async (req, res) => {
  const webhookStartTime = performance.now();
  const update: TelegramBot.Update = req.body;
  if (!update.message || !update.message.chat?.id) { /* ... validação inicial ... */ return; }
  const chatId = update.message.chat.id;
  const logPrefix = `[Webhook Chat ${chatId}]`;
  if (update.message.from?.is_bot) { /* ... ignora bot ... */ return; }
  res.sendStatus(200); // OK Imediato

  try {
    // <<< CORREÇÃO: Usar asserção '!' >>>
    if (update.message!.text && update.message!.text.startsWith('/')) {
      const command = update.message!.text.split(' ')[0].toLowerCase();
      console.info(`${logPrefix} Comando recebido: ${command}`);
      let toolResponse: any; let toolName = ''; let processingMessage = ''; let executorFunction: (() => Promise<any>) | undefined;
      const commandMap: Record<string, { tool: string; msg: string; fn: () => Promise<any> }> = {
        '/elenco': { tool: getFuriaRosterTool.name, msg: 'Buscando o elenco...', fn: executeGetFuriaRoster },
        '/roster': { tool: getFuriaRosterTool.name, msg: 'Buscando o elenco...', fn: executeGetFuriaRoster },
        '/proximo': { tool: getFuriaUpcomingMatchesRapidAPITool.name, msg: 'Conferindo a agenda (API Principal)... 🔥', fn: executeGetFuriaUpcomingMatchesRapidAPI },
        '/next':    { tool: getFuriaUpcomingMatchesRapidAPITool.name, msg: 'Conferindo a agenda (API Principal)... 🔥', fn: executeGetFuriaUpcomingMatchesRapidAPI },
        '/ultimo':  { tool: getFuriaRecentResultsRapidAPITool.name, msg: 'Consultando os resultados (API Principal)... 🏆', fn: executeGetFuriaRecentResultsRapidAPI },
        '/last':    { tool: getFuriaRecentResultsRapidAPITool.name, msg: 'Consultando os resultados (API Principal)... 🏆', fn: executeGetFuriaRecentResultsRapidAPI },
        '/noticias':{ tool: getFuriaNewsHltvTool.name, msg: 'Buscando as últimas notícias da HLTV... 📰', fn: executeGetFuriaNewsHltv },
        '/news':    { tool: getFuriaNewsHltvTool.name, msg: 'Buscando as últimas notícias da HLTV... 📰', fn: executeGetFuriaNewsHltv },
        '/help':    { tool: 'help', msg: '', fn: async () => ({ helpText: "Use /elenco, /proximo, /ultimo, /noticias ou mande sua pergunta!" }) },
        '/start':   { tool: 'help', msg: '', fn: async () => ({ helpText: "E aí! Sou o FURIOSO, seu bot sobre a FURIA CS2! Manda a braba ou use /help." }) }
      };
      const cmdAction = commandMap[command];
      if (cmdAction) {
        toolName = cmdAction.tool; processingMessage = cmdAction.msg; executorFunction = cmdAction.fn;
        if (processingMessage) await bot.sendMessage(chatId, processingMessage);
        console.time(`${logPrefix} Comando ${command} execution`); toolResponse = await executorFunction(); console.timeEnd(`${logPrefix} Comando ${command} execution`);
        const formattedReply = toolName === 'help' ? toolResponse.helpText : formatToolResponseForUser(toolName, toolResponse);
        await bot.sendMessage(chatId, formattedReply, { parse_mode: 'Markdown' });
        console.info(`${logPrefix} Resposta comando ${command} enviada.`);
      } else {
        // <<< CORREÇÃO: Usar asserção '!' >>>
        await bot.sendMessage(chatId!, `Comando "${command}" não reconhecido. Tente /help.`);
      }
      const webhookEndTimeCmd = performance.now(); console.info(`${logPrefix} Comando ${command} | Tempo total: ${Math.round(webhookEndTimeCmd - webhookStartTime)}ms`);
      return;
    }
    // <<< CORREÇÃO: Usar asserção '!' >>>
    else if (update.message!.text) {
      const userMessage = update.message!.text.trim();
      if (!userMessage) return;
      console.info(`${logPrefix} Msg IA recebida: "${userMessage.substring(0,50)}..."`);
      const contextKey = `genkit_history:${chatId}`; let historyForFlow: MessageData[] = [];
      if (redis) { /* ... Busca Histórico ... */ }
      await bot.sendChatAction(chatId, "typing");
      console.time(`${logPrefix} Flow Execution`);
      const flowResult = await runFlow(furiaChatFlow, { userMessage: userMessage, chatHistory: historyForFlow, chatId: chatId });
      console.timeEnd(`${logPrefix} Flow Execution`);
      const finalReply = flowResult; console.info(`${logPrefix} Flow Raw Response: "${finalReply.substring(0, 200)}..."`);
      const lastUser: MessageData = { role: 'user', content: [{ text: userMessage }] }; const lastModel: MessageData = { role: 'model', content: [{ text: finalReply }] };
      const histToSave = [...historyForFlow, lastUser, lastModel]; const MAX_REDIS_HISTORY = 8;
      while (histToSave.length > MAX_REDIS_HISTORY) { histToSave.shift(); }
      if (redis) { /* ... Salva Histórico ... */ }
      try { /* ... Envia Mensagem ... */ } catch (tE) { console.error(`${logPrefix} Erro ao enviar msg Telegram:`, tE); }
      const webhookEndTimeFlow = performance.now(); console.info(`${logPrefix} Fluxo IA | Tempo total: ${Math.round(webhookEndTimeFlow - webhookStartTime)}ms`);
    }
    // <<< CORREÇÃO: Usar asserção '!' >>>
    else if (update.message!.sticker) {
      console.info(`${logPrefix} Sticker recebido.`);
      try { await bot.sendMessage(chatId, "Que sticker maneiro! 🤩 Mas ó, eu funciono melhor com mensagens de texto pra te ajudar com infos da FURIA, beleza? 😉"); }
      catch (e) { console.error(`${logPrefix} Erro resposta sticker:`, e); }
      const webhookEndTimeSticker = performance.now(); console.info(`${logPrefix} Sticker | Tempo total: ${Math.round(webhookEndTimeSticker - webhookStartTime)}ms`);
    }
    else {
      // <<< CORREÇÃO: Usar asserção '!' >>>
      const type = Object.keys(update.message!).filter(k => !['message_id', 'from', 'chat', 'date', 'text', 'sticker'].includes(k))[0] || 'desconhecido';
      console.info(`${logPrefix} Tipo de mensagem não suportado: ${type}`);
      try { await bot.sendMessage(chatId, "Hmm, esse tipo de mensagem eu não consigo processar. 😅 Pode mandar sua dúvida em texto, por favor? 👍"); }
      catch (e) { console.error(`${logPrefix} Erro resposta tipo ${type}:`, e); }
      const webhookEndTimeOther = performance.now(); console.info(`${logPrefix} Tipo ${type} | Tempo total: ${Math.round(webhookEndTimeOther - webhookStartTime)}ms`);
    }
  } catch (globalError) {
    console.error(`${logPrefix} Erro GERAL e NÃO TRATADO no webhook:`, globalError);
    try { await bot.sendMessage(chatId, "🚨 Ops! Encontrei um erro inesperado aqui. Tente novamente mais tarde, por favor."); }
    catch(e){ console.error(`${logPrefix} Falha CRÍTICA ao notificar usuário sobre erro GERAL.`, e);}
    const webhookEndTimeGlobalErr = performance.now(); console.error(`${logPrefix} Erro GERAL | Tempo total até falha: ${Math.round(webhookEndTimeGlobalErr - webhookStartTime)}ms`);
  }
});

// --- Iniciar Servidor Express ---
const port = process.env.PORT || 10000; const host = '0.0.0.0'; const numericPort = Number(port);
if (isNaN(numericPort) || numericPort <= 0) { console.error(`[Init Error] Porta inválida: ${port}. Saindo.`); process.exit(1); }
const server = app.listen(numericPort, host, () => { console.info(`[Init] Servidor Express escutando em https://${host}:${numericPort}`); console.info(`[Init] Webhook Telegram configurado em: ${WEBHOOK_PATH}`); console.info(`[Init] Bot pronto para receber mensagens!`); });

// --- Encerramento Gracioso ---
const gracefulShutdown = (signal: string) => { console.info(`[Shutdown] Recebido sinal ${signal}. Fechando servidor...`); server.close(async () => { console.info('[Shutdown] Servidor HTTP fechado.'); if (redis) { try { await redis.quit(); console.info('[Shutdown] Conexão Redis fechada.'); } catch (e) { console.error('[Shutdown] Erro ao fechar Redis:', e); process.exitCode = 1; } } console.info('[Shutdown] Saindo do processo.'); process.exit(); }); setTimeout(() => { console.error("[Shutdown] Timeout! Forçando encerramento."); process.exit(1); }, 10000); };
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); process.on('SIGINT', () => gracefulShutdown('SIGINT'));
