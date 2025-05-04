/* eslint-disable */
// index.ts
// Versão COMPLETA com ferramentas de partida RapidAPI e Liquipedia Scraper,
// e prompt do sistema refinado para usar ambas as fontes e ter personalidade.

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
        console.info("Conexão Redis OK.");
        redis.on('error', (err) => console.error("Erro Redis:", err));
    } catch (err) { console.error("Falha Redis init:", err); }
} else { console.warn("REDIS_URL não definida."); }


// --- Configuração do Bot Telegram ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const contactInfo = process.env.CONTACT_EMAIL || 'fallback-email@example.com';
if (!telegramToken) { console.error("Erro: TELEGRAM_BOT_TOKEN não definido!"); throw new Error("Token Telegram não configurado."); }
if (contactInfo === 'fallback-email@example.com') { console.warn("AVISO: Variável de ambiente CONTACT_EMAIL não definida."); }
console.info("Token Telegram OK.");
const bot = new TelegramBot(telegramToken);
console.info("Instância Bot Telegram OK.");


// --- Inicialização do Genkit ---
console.info("Inicializando Genkit com plugin googleAI...");
const ai = genkit({
    plugins: [googleAI()],
});
console.info("Instância Genkit 'ai' criada.");

// --- Constantes da API ---
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'esportapi1.p.rapidapi.com';
const FURIA_TEAM_ID = '364252';
const LIQUIPEDIA_API_URL = 'https://liquipedia.net/counterstrike/api.php';
const LIQUIPEDIA_PAGE_NAME_MAIN = 'FURIA';
const LIQUIPEDIA_PAGE_NAME_MATCHES = 'FURIA/Matches';
const CUSTOM_USER_AGENT = `FuriaChatChallengeBot/1.0 (${contactInfo})`;

// --- Definição das Ferramentas ---

// --- Ferramenta Roster (HLTV/Liquipedia Fallback) ---
export enum TeamPlayerType { Coach = "Coach", Starter = "Starter", Substitute = "Substitute", Benched = "Benched" }
const rosterCacheSchema = z.object({ playersInfo: z.string().optional(), error: z.string().optional(), source: z.enum(['hltv', 'liquipedia', 'cache-hltv', 'cache-liquipedia']).optional() });
const furiaRosterOutputSchema = z.object({ playersInfo: z.string().optional().describe("String formatada com nome e tipo dos jogadores. Ex: 'yuurih, KSCERATO, FalleN (Captain), molodoy, YEKINDAR (Stand-in), sidde (Coach)'"), error: z.string().optional().describe("Mensagem de erro se a busca falhar."), source: z.enum(['HLTV', 'Liquipedia']).optional().describe("Fonte da informação.") });
async function executeGetFuriaRoster(): Promise<z.infer<typeof furiaRosterOutputSchema>> {
    console.info("[Tool Exec] getFuriaRoster chamada (HLTV com fallback Liquipedia API).");
    const hltvCacheKey = "hltv:furia_roster_v3";
    const liquipediaCacheKey = "liquipedia:furia_roster_v3";
    const CACHE_TTL_SUCCESS = 14400; // 4 hours
    const CACHE_TTL_ERROR = 3600;    // 1 hour

    let hltvResult: z.infer<typeof rosterCacheSchema> | null = null;
    let isCloudflareBlock = false;

    // 1a. Checar Cache HLTV
    if (redis) {
        try {
            const cachedData = await redis.get(hltvCacheKey);
            if (cachedData) {
                const parsedCache = rosterCacheSchema.parse(JSON.parse(cachedData));
                if (parsedCache && !parsedCache.error) {
                    console.info(`[Cache HLTV] hit ${hltvCacheKey}`);
                    return { playersInfo: parsedCache.playersInfo, source: 'HLTV' };
                } else if (parsedCache?.error) {
                    console.warn(`[Cache HLTV] hit com erro ${hltvCacheKey}: ${parsedCache.error}`);
                    if (parsedCache.error.includes('Cloudflare') || parsedCache.error.includes('Access denied') || parsedCache.error.includes('bloqueio')) {
                        isCloudflareBlock = true;
                    }
                }
            } else { console.info(`[Cache HLTV] miss ${hltvCacheKey}`); }
        } catch (e) { console.error(`[Cache HLTV] erro read ${hltvCacheKey}`, e); }
    }

    // 1b. Tentar API HLTV
    if (!isCloudflareBlock) {
        console.info("[HLTV API] Tentando buscar dados...");
        try {
            const team = await HLTV.getTeam({ id: 8297 });
            if (!team?.players?.length) throw new Error("Dados/jogadores não encontrados no HLTV.");
            const players = team.players
              .map(p => {
                  let role = '';
                  if (p.type === TeamPlayerType.Coach) role = ' (Coach)';
                  // Adicionar outras roles se necessário (ex: Stand-in)
                  return p.name ? `${p.name}${role}` : null;
              })
              .filter((p): p is string => p !== null);
            if (players.length === 0) throw new Error("Nenhum jogador/coach válido encontrado no HLTV.");
            const playersInfo = players.join(', ');
            console.info(`[HLTV API] Sucesso: ${playersInfo}`);
            hltvResult = { playersInfo: playersInfo, source: 'hltv' };
            if (redis) {
                try { await redis.set(hltvCacheKey, JSON.stringify(hltvResult), 'EX', CACHE_TTL_SUCCESS); }
                catch (e) { console.error(`[Cache HLTV] erro save success ${hltvCacheKey}`, e); }
            }
            return { playersInfo: hltvResult.playersInfo, source: 'HLTV' };
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error("[HLTV API] Erro:", errorMsg);
            isCloudflareBlock = errorMsg.includes('Cloudflare') || errorMsg.includes('Access denied');
            const errorToCache = `Falha ao buscar no HLTV: ${isCloudflareBlock ? 'Bloqueio Cloudflare detectado.' : errorMsg}`;
            hltvResult = { error: errorToCache, source: 'hltv' };
            if (redis) {
                try { await redis.set(hltvCacheKey, JSON.stringify(hltvResult), 'EX', CACHE_TTL_ERROR); }
                catch (e) { console.error(`[Cache HLTV] erro save error ${hltvCacheKey}`, e); }
            }
            if (!isCloudflareBlock) {
                console.warn("[HLTV API] Falha não relacionada ao Cloudflare, tentando Liquipedia...");
            }
        }
    } else {
        console.warn("[HLTV] Bloqueio Cloudflare detectado ou erro cacheado, pulando para Liquipedia.");
    }

    // 2. Tentar Liquipedia API como Fallback
    console.info("[Liquipedia Fallback] Tentando buscar na API MediaWiki (Roster)...");
    let liquipediaResult: z.infer<typeof rosterCacheSchema> | null = null;
    if (redis) {
        try {
            const cachedData = await redis.get(liquipediaCacheKey);
            if (cachedData) {
                try {
                    const parsedCache = rosterCacheSchema.parse(JSON.parse(cachedData));
                    if (parsedCache && !parsedCache.error) {
                        console.info(`[Cache Liquipedia] hit ${liquipediaCacheKey}`);
                        return { playersInfo: parsedCache.playersInfo, source: 'Liquipedia' };
                    } else if (parsedCache?.error) {
                        console.warn(`[Cache Liquipedia] hit com erro ${liquipediaCacheKey}: ${parsedCache.error}. Tentando buscar novamente.`);
                    }
                } catch (parseErr) {
                    console.warn(`[Cache Liquipedia] Erro ao parsear cache ${liquipediaCacheKey}. Buscando novamente.`, parseErr)
                }
            } else { console.info(`[Cache Liquipedia] miss ${liquipediaCacheKey}`); }
        } catch (e) { console.error(`[Cache Liquipedia] erro read ${liquipediaCacheKey}`, e); }
    }

    try {
        console.info(`[Liquipedia API] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MAIN}...`);
        const response = await axios.get(LIQUIPEDIA_API_URL, { params: { action: 'parse', page: LIQUIPEDIA_PAGE_NAME_MAIN, prop: 'text', format: 'json', disabletoc: true }, headers: { 'User-Agent': CUSTOM_USER_AGENT, 'Accept-Encoding': 'gzip' }, timeout: 20000 });
        if (response.data?.error) throw new Error(`API Liquipedia retornou erro: ${response.data.error.info}`);
        const htmlContent = response.data?.parse?.text?.['*'];
        if (!htmlContent) throw new Error("Conteúdo HTML não encontrado na resposta da API Liquipedia.");
        const $ = cheerio.load(htmlContent);
        const players: string[] = [];
        const activeHeader = $('h3 > span#Active');
        if (activeHeader.length === 0) throw new Error("Não foi possível encontrar o header 'Active' do elenco de jogadores.");
        const rosterTableWrapper = activeHeader.closest('h3').nextAll('div.table-responsive.roster-card-wrapper').first();
        const rosterTable = rosterTableWrapper.find('table.wikitable.roster-card').first();
        if (rosterTable.length === 0) throw new Error("Não foi possível encontrar a tabela de elenco ('roster-card') após o header 'Active'.");

        console.info("[Liquipedia Parser] Tabela de elenco 'Active' encontrada, processando linhas...");
        rosterTable.find('tbody tr.Player').each((_rowIndex, row) => {
            const $row = $(row);
            const playerLink = $row.find('td.ID a').first();
            let playerName: string | undefined = playerLink.attr('title');
            if (!playerName || playerName.includes('(page does not exist)')) {
                const fallbackName = playerLink.text().trim();
                if (fallbackName) { playerName = fallbackName; } else { playerName = undefined; }
            }
            if(playerName) {
                playerName = playerName.trim();
                const playerRole = $row.find('td.Position i').text().trim();
                players.push(playerRole ? `${playerName} ${playerRole}` : playerName);
            }
        });

        if (players.length > 0) {
            const playersInfo = players.join(', ');
            console.info("[Liquipedia API] Sucesso (Roster):", playersInfo);
            liquipediaResult = { playersInfo: playersInfo, source: 'liquipedia' };
        } else {
            throw new Error("Extração da tabela de elenco ativa não retornou jogadores.");
        }
    } catch (scrapeErr) {
        const errorMsg = scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
        console.error("[Liquipedia API] Erro (Roster):", errorMsg);
        liquipediaResult = { error: `Falha Liquipedia (Roster): ${errorMsg}`, source: 'liquipedia' };
    }

    if (redis && liquipediaResult) {
        try {
            const ttl = liquipediaResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            await redis.set(liquipediaCacheKey, JSON.stringify(liquipediaResult), 'EX', ttl);
            console.info(`[Cache Liquipedia] saved ${liquipediaCacheKey} (ttl: ${ttl})`);
        } catch (e) { console.error(`[Cache Liquipedia] erro save ${liquipediaCacheKey}`, e); }
    }

    if (liquipediaResult && !liquipediaResult.error) {
        return { playersInfo: liquipediaResult.playersInfo, source: 'Liquipedia' };
    } else {
        const hltvErrorReason = isCloudflareBlock ? "Bloqueio Cloudflare" : (hltvResult?.error || "Falha desconhecida");
        const liquipediaErrorReason = liquipediaResult?.error || "Erro desconhecido";
        const finalError = `Falha ao obter dados do Roster. HLTV: ${hltvErrorReason}. Liquipedia: ${liquipediaErrorReason}. Tente novamente mais tarde.`;
        console.error("[Tool Exec] Falha em ambas as fontes (Roster):", finalError);
        return { error: finalError };
    }
}
const getFuriaRosterTool = ai.defineTool({ name: "getFuriaRoster", description: "Busca a escalação ATUAL da FURIA CS2 (HLTV/Liquipedia).", inputSchema: z.object({}), outputSchema: furiaRosterOutputSchema }, executeGetFuriaRoster);

// --- Ferramenta Wikipedia ---
const wikipediaSearchSchema = z.object({ searchTerm: z.string().describe("Termo a pesquisar na Wikipedia") });
const wikipediaOutputSchema = z.object({ summary: z.string().optional(), error: z.string().optional(), source: z.literal('cache').or(z.literal('api')).optional() });
async function executeSearchWikipedia(input: z.infer<typeof wikipediaSearchSchema>): Promise<z.infer<typeof wikipediaOutputSchema>> {
    const searchTerm = input.searchTerm;
    console.info(`[Tool Exec] searchWikipedia buscando '${searchTerm}'.`);
    const cacheKey = `wiki:${searchTerm.toLowerCase().replace(/\s+/g, '_')}`;
    const CACHE_TTL_SUCCESS = 86400;
    const CACHE_TTL_ERROR = 3600;

    // 1. Cache Check
    if (redis) {
        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                try {
                    const parsedCache = JSON.parse(cachedData);
                    const validation = wikipediaOutputSchema.safeParse(parsedCache);
                    if (validation.success) {
                        if (validation.data.summary) {
                            console.info(`[Cache Wiki] hit ${searchTerm}`);
                            return { ...validation.data, source: 'cache' };
                        }
                        if (validation.data.error) console.warn(`[Cache Wiki] Erro cacheado para ${searchTerm}: ${validation.data.error}`);
                    } else {
                        console.warn(`[Cache Wiki] Dados inválidos no cache para ${searchTerm}, buscando novamente.`);
                    }
                } catch (parseError) {
                    console.warn(`[Cache Wiki] Erro ao parsear cache para ${searchTerm}, buscando novamente.`, parseError);
                }
            } else {
                console.info(`[Cache Wiki] miss ${searchTerm}`);
            }
        } catch (e) { console.error(`[Cache Wiki] erro read ${searchTerm}`, e); }
    }

    // 2. API Call
    try {
        wiki.setLang('pt');
        const page = await wiki.page(searchTerm, { autoSuggest: true });
        let apiResult: z.infer<typeof wikipediaOutputSchema>;

        if (!page) {
            console.warn(`[Wiki API] Página '${searchTerm}' não encontrada.`);
            apiResult = { error: `Página '${searchTerm}' não encontrada na Wikipedia.` };
        } else {
            const summaryResult = await page.summary();
            if (!summaryResult?.extract) {
                console.warn(`[Wiki API] Resumo vazio para ${searchTerm}.`);
                apiResult = { error: `Não foi possível obter um resumo para '${searchTerm}'.` };
            } else {
                const MAX_SUMMARY_LENGTH = 1500;
                let summaryText = summaryResult.extract;
                if (summaryText.length > MAX_SUMMARY_LENGTH) {
                    summaryText = summaryText.substring(0, MAX_SUMMARY_LENGTH) + "... (resumo truncado)";
                    console.info(`[Wiki API] Resumo truncado para ${searchTerm}.`);
                }
                apiResult = { summary: summaryText, source: 'api' };
                console.info(`[Wiki API] Resumo obtido para ${searchTerm}.`);
            }
        }

        // 3. Cache Result
        if (redis) {
            try {
                const ttl = apiResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
                await redis.set(cacheKey, JSON.stringify(apiResult), 'EX', ttl);
                console.info(`[Cache Wiki] saved ${searchTerm} (ttl: ${ttl})`);
            } catch (e) { console.error(`[Cache Wiki] erro save ${searchTerm}`, e); }
        }
        return apiResult;

    } catch (err) {
        console.error(`[Wiki API] Erro ${searchTerm}:`, err);
        const msg = err instanceof Error ? err.message : "Erro desconhecido";
        let errorMsg = `Erro ao buscar '${searchTerm}' na Wikipedia: ${msg}`;
        if (String(err).includes('No article found')) {
            errorMsg = `Artigo '${searchTerm}' não encontrado na Wikipedia.`;
        }
        const errorResult = { error: errorMsg };

        // 4. Cache Error
        if (redis) {
            try {
                await redis.set(cacheKey, JSON.stringify(errorResult), 'EX', CACHE_TTL_ERROR);
                console.info(`[Cache Wiki] saved API error for ${searchTerm}`);
            } catch (e) { console.error(`[Cache Wiki] erro save api err ${searchTerm}`, e); }
        }
        return errorResult;
    }
}
const searchWikipediaTool = ai.defineTool({ name: "searchWikipedia", description: "Busca um resumo sobre um tópico na Wikipedia (jogador, time, evento).", inputSchema: wikipediaSearchSchema, outputSchema: wikipediaOutputSchema }, executeSearchWikipedia);

// --- Ferramenta Próximas Partidas (RapidAPI) ---
const upcomingMatchesRapidAPIOutputSchema = z.object({ matchesInfo: z.string().optional().describe("String com próximas partidas da API. Ex: 'vs NAVI (ESL Pro League) - 10/05/2025 14:00 (BRT); ...' ou msg de 'não encontrado'."), error: z.string().optional() });
async function executeGetFuriaUpcomingMatchesRapidAPI(): Promise<z.infer<typeof upcomingMatchesRapidAPIOutputSchema>> {
    console.info("[Tool Exec] getFuriaUpcomingMatchesRapidAPI chamada.");
    const cacheKey = "rapidapi:furia_upcoming_v1";
    const CACHE_TTL_SUCCESS = 7200; // 2 hours
    const CACHE_TTL_ERROR = 1800;   // 30 mins

    if (!RAPIDAPI_KEY) return { error: "Chave da API (RapidAPI) não configurada no servidor." };

    // 1. Cache Check
    if (redis) {
        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                console.info(`[Cache RapidAPI Upcoming] hit ${cacheKey}`);
                return JSON.parse(cachedData); // Assume cache está válido
            } else { console.info(`[Cache RapidAPI Upcoming] miss ${cacheKey}`); }
        } catch(e) { console.error(`[Cache RapidAPI Upcoming] Erro read ${cacheKey}:`, e); }
    }

    // 2. API Call
    const options = { method: 'GET', url: `https://${RAPIDAPI_HOST}/api/esport/team/${FURIA_TEAM_ID}/matches/next/3`, headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST }, timeout: 15000 };
    let result: z.infer<typeof upcomingMatchesRapidAPIOutputSchema>;
    try {
        const response = await axios.request(options);
        const data = response.data;
        if (!data || !Array.isArray(data.events) || data.events.length === 0) {
            console.info("[RapidAPI] Nenhuma partida futura encontrada.");
            result = { matchesInfo: "Nenhuma partida futura encontrada (API)." };
        } else {
            const matches = data.events.map((match: any) => {
                const opponent = match.awayTeam?.name ?? match.homeTeam?.name ?? 'Oponente Desconhecido'; // Ajustar se necessário
                const tournament = match.tournament?.name ?? 'Torneio Desconhecido';
                const timestamp = match.startTimestamp;
                let formattedDate = 'Data Indisponível';
                if (timestamp) {
                    try { formattedDate = new Date(timestamp * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) + ' (BRT)'; }
                    catch (e) { console.error("Erro ao formatar data da API:", e); }
                }
                return `vs ${opponent} (${tournament}) - ${formattedDate}`;
            }).filter((m: string | string[]) => !m.includes('Data Indisponível')); // Filtra se data falhou
            result = { matchesInfo: matches.length > 0 ? matches.join('; ') : "Nenhuma partida futura com data encontrada (API)." };
        }
        console.info("[RapidAPI] Sucesso (Upcoming):", result.matchesInfo);
    } catch (error: any) {
        console.error("[RapidAPI] Erro ao buscar próximas partidas:", error.response?.data || error.message);
        let errorMsg = `Falha ao buscar próximas partidas na API (${error.code || 'Erro Desconhecido'}).`;
        if(error.response?.status === 429) errorMsg = "Limite de chamadas da API de partidas atingido.";
        if(error.response?.status === 403) errorMsg = "Acesso negado à API de partidas (Verifique a chave).";
        result = { error: errorMsg };
    }

    // 3. Cache Result/Error
    if(redis) {
        try {
            const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl);
            console.info(`[Cache RapidAPI Upcoming] saved ${cacheKey} (ttl: ${ttl})`);
        } catch(e) { console.error(`[Cache RapidAPI Upcoming] Erro save ${cacheKey}:`, e); }
    }
    return result;
}
const getFuriaUpcomingMatchesRapidAPITool = ai.defineTool({ name: "getFuriaUpcomingMatchesRapidAPI", description: "Busca as próximas 3 partidas da FURIA CS2 (Fonte: API Externa).", inputSchema: z.object({}), outputSchema: upcomingMatchesRapidAPIOutputSchema }, executeGetFuriaUpcomingMatchesRapidAPI);

// --- Ferramenta Resultados Recentes (RapidAPI) ---
const recentResultsRapidAPIOutputSchema = z.object({ resultsInfo: z.string().optional().describe("String com resultados recentes da API. Ex: 'vs NAVI (L 0-2) (ESL Pro League); ...' ou msg de 'não encontrado'."), error: z.string().optional() });
async function executeGetFuriaRecentResultsRapidAPI(): Promise<z.infer<typeof recentResultsRapidAPIOutputSchema>> {
    console.info("[Tool Exec] getFuriaRecentResultsRapidAPI chamada.");
    const cacheKey = "rapidapi:furia_recent_v1";
    const CACHE_TTL_SUCCESS = 3600; // 1 hour
    const CACHE_TTL_ERROR = 1800;   // 30 mins

    if (!RAPIDAPI_KEY) return { error: "Chave da API (RapidAPI) não configurada." };

    // 1. Cache Check
    if (redis) {
        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                console.info(`[Cache RapidAPI Recent] hit ${cacheKey}`);
                return JSON.parse(cachedData);
            } else { console.info(`[Cache RapidAPI Recent] miss ${cacheKey}`); }
        } catch(e) { console.error(`[Cache RapidAPI Recent] Erro read ${cacheKey}:`, e); }
    }

    // 2. API Call
    const options = { method: 'GET', url: `https://${RAPIDAPI_HOST}/api/esport/team/${FURIA_TEAM_ID}/matches/last/5`, headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST }, timeout: 15000};
    let result: z.infer<typeof recentResultsRapidAPIOutputSchema>;
    try {
        const response = await axios.request(options);
        const data = response.data;
        if (!data || !Array.isArray(data.events) || data.events.length === 0) {
            console.info("[RapidAPI] Nenhum resultado recente encontrado.");
            result = { resultsInfo: "Nenhum resultado recente encontrado (API)." };
        } else {
            const results = data.events.map((match: any) => {
                const homeTeam = match.homeTeam;
                const awayTeam = match.awayTeam;
                const homeScore = match.homeScore?.display; // Usar 'display' pode ser melhor que 'current'
                const awayScore = match.awayScore?.display;
                const tournament = match.tournament?.name ?? 'Torneio';
                const winnerCode = match.winnerCode;

                let opponentName = 'Oponente Desconhecido';
                let furiaScore = '?';
                let opponentScore = '?';
                let outcome = '';

                if (homeTeam?.id?.toString() === FURIA_TEAM_ID) {
                    opponentName = awayTeam?.name ?? opponentName;
                    furiaScore = homeScore ?? '?';
                    opponentScore = awayScore ?? '?';
                    if (winnerCode === 1) outcome = 'W'; else if (winnerCode === 2) outcome = 'L';
                } else if (awayTeam?.id?.toString() === FURIA_TEAM_ID) {
                    opponentName = homeTeam?.name ?? opponentName;
                    furiaScore = awayScore ?? '?';
                    opponentScore = homeScore ?? '?';
                    if (winnerCode === 2) outcome = 'W'; else if (winnerCode === 1) outcome = 'L';
                } else {
                    console.warn(`[RapidAPI Recent] FURIA Team ID ${FURIA_TEAM_ID} não encontrado em home (${homeTeam?.id}) ou away (${awayTeam?.id}).`);
                    opponentName = `${homeTeam?.name ?? '?'} vs ${awayTeam?.name ?? '?'}`;
                }
                const scoreString = (outcome && furiaScore !== '?' && opponentScore !== '?') ? `(${outcome} ${furiaScore}-${opponentScore})` : '';
                return `vs ${opponentName} ${scoreString} (${tournament})`;
            });
            result = { resultsInfo: results.length > 0 ? results.join('; ') : "Nenhum resultado recente encontrado (API)." };
        }
        console.info("[RapidAPI] Sucesso (Recent Results):", result.resultsInfo);
    } catch (error: any) {
        console.error("[RapidAPI] Erro ao buscar resultados recentes:", error.response?.data || error.message);
        let errorMsg = `Falha ao buscar resultados recentes na API (${error.code || 'Erro Desconhecido'}).`;
        if(error.response?.status === 429) errorMsg = "Limite de chamadas da API de partidas atingido.";
        if(error.response?.status === 403) errorMsg = "Acesso negado à API de partidas (Verifique a chave).";
        result = { error: errorMsg };
    }

    // 3. Cache Result/Error
    if(redis) {
        try {
            const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl);
            console.info(`[Cache RapidAPI Recent] saved ${cacheKey} (ttl: ${ttl})`);
        } catch(e) { console.error(`[Cache RapidAPI Recent] Erro save ${cacheKey}:`, e); }
    }
    return result;
}
const getFuriaRecentResultsRapidAPITool = ai.defineTool({ name: "getFuriaRecentResultsRapidAPI", description: "Busca os 5 resultados mais recentes da FURIA CS2 (Fonte: API Externa).", inputSchema: z.object({}), outputSchema: recentResultsRapidAPIOutputSchema }, executeGetFuriaRecentResultsRapidAPI);

// --- Ferramenta Próximas Partidas (Liquipedia Scraper) ---
const upcomingMatchesLiquipediaOutputSchema = z.object({ matchesInfo: z.string().optional().describe("String com próximas partidas da Liquipedia. Ex: 'vs G2 (BLAST Premier) - 12/05/2025 10:00 (BRT); ...' ou msg 'não encontrado'."), error: z.string().optional() });
async function executeGetFuriaUpcomingMatchesLiquipedia(): Promise<z.infer<typeof upcomingMatchesLiquipediaOutputSchema>> {
    console.info("[Tool Exec] getFuriaUpcomingMatchesLiquipedia chamada.");
    const cacheKey = "liquipedia:furia_upcoming_v1";
    const CACHE_TTL_SUCCESS = 7200; // 2 hours
    const CACHE_TTL_ERROR = 1800;   // 30 mins

    // 1. Cache Check
    if (redis) {
        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                console.info(`[Cache Liquipedia Upcoming] hit ${cacheKey}`);
                return JSON.parse(cachedData);
            } else { console.info(`[Cache Liquipedia Upcoming] miss ${cacheKey}`); }
        } catch(e) { console.error(`[Cache Liquipedia Upcoming] Erro read ${cacheKey}:`, e); }
    }

    // 2. Scrape Call
    let result: z.infer<typeof upcomingMatchesLiquipediaOutputSchema>;
    try {
        console.info(`[Liquipedia Scraper] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MAIN} (Upcoming Matches)...`);
        const response = await axios.get(LIQUIPEDIA_API_URL, { params: { action: 'parse', page: LIQUIPEDIA_PAGE_NAME_MAIN, prop: 'text', format: 'json', disabletoc: true }, headers: { 'User-Agent': CUSTOM_USER_AGENT, 'Accept-Encoding': 'gzip' }, timeout: 20000 });
        if (response.data?.error) throw new Error(`API Liquipedia retornou erro: ${response.data.error.info}`);
        const htmlContent = response.data?.parse?.text?.['*'];
        if (!htmlContent) throw new Error("Conteúdo HTML não encontrado na resposta da API Liquipedia.");
        const $ = cheerio.load(htmlContent);
        const matches: string[] = [];

        // Seletor (EXEMPLO - PODE PRECISAR AJUSTE) para a tabela de próximos jogos no Infobox
        // Acessa a primeira tabela dentro do div fo-nttax-infobox que tem a classe infobox_matches_content
        $('div.fo-nttax-infobox table.infobox_matches_content').first().find('tbody tr').each((_idx, row) => {
            const $row = $(row);
            // Procura pelo nome do torneio/oponente - estrutura pode variar muito!
            const tournamentLink = $row.find('td a').first(); // Link do torneio/partida
            const opponentMaybe = $row.find('.opponent-flex a').last().text().trim(); // Tentativa de achar oponente
            const tournamentName = tournamentLink.attr('title') || tournamentLink.text().trim() || 'Torneio?';
            const dateTimeElement = $row.find('.timer-object'); // Pega data/hora
            const dateTime = dateTimeElement.text().trim() || dateTimeElement.data('timestamp');

            if (tournamentName.toLowerCase() !== 'upcoming tournaments' && dateTime) { // Evita header
                let formattedDate = dateTime;
                if (!isNaN(Number(dateTime))) {
                    try { formattedDate = new Date(Number(dateTime) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) + ' (BRT)'; }
                    catch(e) { /* ignora erro */ }
                }
                // Tenta montar a string (pode precisar ajustar o oponente)
                matches.push(`vs ${opponentMaybe || '?'} (${tournamentName}) - ${formattedDate} (Liquipedia)`);
            }
            if (matches.length >= 3) return false; // Limita
        });

        if (matches.length > 0) {
            result = { matchesInfo: matches.join('; ') };
            console.info("[Liquipedia Scraper] Sucesso (Upcoming):", result.matchesInfo);
        } else {
            console.info("[Liquipedia Scraper] Nenhuma próxima partida encontrada com os seletores atuais.");
            result = { matchesInfo: "Nenhuma partida futura encontrada (Liquipedia)." };
        }
    } catch (error: any) {
        console.error("[Liquipedia Scraper] Erro (Upcoming):", error.message);
        result = { error: `Falha Liquipedia Upcoming: ${error.message}` };
    }

    // 3. Cache Result/Error
    if(redis) {
        try {
            const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl);
            console.info(`[Cache Liquipedia Upcoming] saved ${cacheKey} (ttl: ${ttl})`);
        } catch(e) { console.error(`[Cache Liquipedia Upcoming] Erro save ${cacheKey}:`, e); }
    }
    return result;
}
const getFuriaUpcomingMatchesLiquipediaTool = ai.defineTool({ name: "getFuriaUpcomingMatchesLiquipedia", description: "Busca as próximas 3 partidas da FURIA CS2 (Fonte: Liquipedia Scraper - pode falhar).", inputSchema: z.object({}), outputSchema: upcomingMatchesLiquipediaOutputSchema }, executeGetFuriaUpcomingMatchesLiquipedia);

// --- Ferramenta Resultados Recentes (Liquipedia Scraper) ---
const recentResultsLiquipediaOutputSchema = z.object({ resultsInfo: z.string().optional().describe("String com resultados recentes da Liquipedia. Ex: 'vs FAZE (W 2-0) (IEM); ...' ou msg 'não encontrado'."), error: z.string().optional() });
async function executeGetFuriaRecentResultsLiquipedia(): Promise<z.infer<typeof recentResultsLiquipediaOutputSchema>> {
    console.info("[Tool Exec] getFuriaRecentResultsLiquipedia chamada.");
    const cacheKey = "liquipedia:furia_recent_v1";
    const CACHE_TTL_SUCCESS = 3600; // 1 hour
    const CACHE_TTL_ERROR = 1800;   // 30 mins

    // 1. Cache Check
    if (redis) {
        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                console.info(`[Cache Liquipedia Recent] hit ${cacheKey}`);
                return JSON.parse(cachedData);
            } else { console.info(`[Cache Liquipedia Recent] miss ${cacheKey}`); }
        } catch(e) { console.error(`[Cache Liquipedia Recent] Erro read ${cacheKey}:`, e); }
    }

    // 2. Scrape Call
    let result: z.infer<typeof recentResultsLiquipediaOutputSchema>;
    try {
        console.info(`[Liquipedia Scraper] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME_MATCHES} (Recent Results)...`);
        // Usar LIQUIPEDIA_PAGE_NAME_MATCHES pode ser mais eficaz
        const response = await axios.get(LIQUIPEDIA_API_URL, { params: { action: 'parse', page: LIQUIPEDIA_PAGE_NAME_MATCHES, prop: 'text', format: 'json', disabletoc: true }, headers: { 'User-Agent': CUSTOM_USER_AGENT, 'Accept-Encoding': 'gzip' }, timeout: 20000 });
        if (response.data?.error) throw new Error(`API Liquipedia retornou erro: ${response.data.error.info}`);
        const htmlContent = response.data?.parse?.text?.['*'];
        if (!htmlContent) throw new Error("Conteúdo HTML não encontrado na resposta da API Liquipedia.");
        const $ = cheerio.load(htmlContent);
        const results: string[] = [];

        // Seletor EXTREMAMENTE FRÁGIL para tabela de resultados recentes
        $('.wikitable.recent-matches tbody tr').each((_index, element) => {
            const $row = $(element);
            // Tenta extrair os dados - a ordem e classes podem variar MUITO
            const opponentTeamLink = $row.find('td:nth-child(3) .team-template-text a').first(); // Suposição
            const opponentName = opponentTeamLink.text().trim() || $row.find('td:nth-child(3)').text().trim(); // Fallback
            const score = $row.find('td:nth-child(2)').text().trim(); // Suposição
            const tournamentLink = $row.find('td:last-child a').first(); // Suposição
            const tournamentName = tournamentLink.attr('title') || tournamentLink.text().trim() || 'Torneio';

            if (score.includes(':') && opponentName) { // Verifica se tem placar
                // Lógica de W/L aqui seria complexa e frágil sem saber a posição da FURIA na linha
                results.push(`vs ${opponentName} (${score}) (${tournamentName}) (Liquipedia)`);
            }
            if (results.length >= 5) return false; // Limita
        });

        if (results.length > 0) {
            result = { resultsInfo: results.join('; ') };
            console.info("[Liquipedia Scraper] Sucesso (Recent Results):", result.resultsInfo);
        } else {
            console.info("[Liquipedia Scraper] Nenhum resultado recente encontrado com os seletores atuais.");
            result = { resultsInfo: "Nenhum resultado recente encontrado (Liquipedia)." };
        }
    } catch (error: any) {
        console.error("[Liquipedia Scraper] Erro (Recent Results):", error.message);
        result = { error: `Falha Liquipedia Results: ${error.message}` };
    }

    // 3. Cache Result/Error
    if(redis) {
        try {
            const ttl = result.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl);
            console.info(`[Cache Liquipedia Recent] saved ${cacheKey} (ttl: ${ttl})`);
        } catch(e) { console.error(`[Cache Liquipedia Recent] Erro save ${cacheKey}:`, e); }
    }
    return result;
}
const getFuriaRecentResultsLiquipediaTool = ai.defineTool({ name: "getFuriaRecentResultsLiquipedia", description: "Busca os 5 resultados mais recentes da FURIA CS2 (Fonte: Liquipedia Scraper - pode falhar).", inputSchema: z.object({}), outputSchema: recentResultsLiquipediaOutputSchema }, executeGetFuriaRecentResultsLiquipedia);


// --- Definição do Flow Principal do Chat ---
const flowInputSchema = z.object({ userMessage: z.string(), chatHistory: z.array(z.any()).optional().default([]), });
const furiaChatFlow = defineFlow(
  {
      name: "furiaChatFlow",
      inputSchema: flowInputSchema,
      outputSchema: z.string().describe("Resposta final do assistente para o usuário"),
  },
  async (input): Promise<string> => {
      const { userMessage, chatHistory } = input;
      console.info(`[Flow] Mensagem: "${userMessage}" | Histórico recebido: ${chatHistory.length} msgs`);

      const validHistory: MessageData[] = chatHistory
        .map((msg: any) => {
            if (msg && typeof msg.role === 'string' && Array.isArray(msg.content)) {
                const validContent = msg.content.every((part: any) => typeof part.text === 'string' || part.toolRequest || part.toolResponse);
                if (validContent) return msg as MessageData;
            }
            console.warn("[Flow] Mensagem inválida no histórico recebido:", msg);
            return null;
        })
        .filter((msg): msg is MessageData => msg !== null);

      const currentHistory: MessageData[] = [...validHistory];
      currentHistory.push({ role: 'user', content: [{ text: userMessage }] });

      const MAX_FLOW_HISTORY_MESSAGES = 8;
      while (currentHistory.length > MAX_FLOW_HISTORY_MESSAGES) { currentHistory.shift(); }
      console.info(`[Flow] Histórico antes da IA (após adição/trim): ${currentHistory.length} msgs`);

      const systemInstruction = `Você é FURIOSO, o assistente virtual oficial e super fã da FURIA Esports! Sua missão é ajudar a galera com informações precisas e atualizadas sobre nosso time de CS2, sempre com muito entusiasmo! Lembre-se do nosso papo anterior pra gente continuar na mesma página! 😉
        - **Tom:** Responda sempre em português do Brasil. Seja amigável, caloroso, um pouco brincalhão e MUITO apaixonado pela FURIA! Mostre empolgação! Use exclamações! Uma gíria gamer leve (rushar, GGWP, na mira!) cai bem de vez em quando, mas sem exagerar.
        - **Emojis:** Use emojis 🐾🔥🏆🔫🥳🎉 para deixar a conversa mais viva e com a nossa cara! Mas use com moderação, tá?
        - **Persona:** Você faz parte da família FURIA! Use "nós", "nosso time", "nossa pantera".
        - **Foco TOTAL:** Sua especialidade é a FURIA CS2. Responda SOMENTE sobre nossos jogadores, coach, staff, partidas, história e notícias relacionadas. Se perguntarem de outros times ou jogos sem conexão direta, diga educadamente que você é especialista na FURIA: "Opa! Meu foco é 100% FURIA aqui! 🐾 De outros times eu não vou saber te dizer agora, beleza?". Não opine sobre performance ou dê conselhos de aposta.
        - **Uso das Ferramentas (Sua Caixa de Habilidades! 🛠️):**
            - **Escalação ATUAL?** Manda um 'getFuriaRoster'! Rápido como um rush no bomb! 🔥
            - **Próximos Jogos?** Tente buscar nas DUAS fontes: use 'getFuriaUpcomingMatchesRapidAPI' (essa API é show!) e também 'getFuriaUpcomingMatchesLiquipedia' (essa raspa dados, pode falhar às vezes).
            - **Resultados Recentes?** Mesma tática: tente 'getFuriaRecentResultsRapidAPI' e 'getFuriaRecentResultsLiquipedia'.
            - **Alguém Específico (Jogador/Coach/Staff)?** Primeiro, chama o 'searchWikipedia' pra saber tudo sobre a lenda! Depois você monta a resposta com suas palavras.
            - **Outros Tópicos (Torneios, Conceitos CS)?** 'searchWikipedia' também te ajuda, mas sempre conecte com a FURIA se fizer sentido!
        - **Como Responder (O mais importante!):**
            - **NADA de CTRL+C/CTRL+V!** Use as informações das ferramentas, mas explique com as SUAS palavras, no SEU estilo FURIOSO. Seja original!
            - **Sintetize Dados de Jogos:** Se as ferramentas de jogos (API e Liquipedia) retornarem infos:
                - Iguais? Ótimo! Apresenta a info confirmada! Ex: "Confirmado nas minhas fontes! Próximo jogo é [Info]! #DIADEFURIA"
                - Diferentes? Seja transparente! Ex: "Olha, a API diz [Info API], já a Liquipedia mostra [Info Liquipedia]. A API costuma ser mais atual, mas tá aí as duas infos! 👍"
                - Só uma funcionou? Use ela e diga qual foi! Ex: "Busquei na API aqui: [Info API]" ou "Pela Liquipedia, o último jogo foi [Info Liquipedia]".
            - **VARIE!** Não comece e termine as frases sempre igual. Use saudações criativas, apresente os dados de formas diferentes.
            - **ENGAGE!** QUASE SEMPRE termine sua resposta com uma pergunta para manter o papo rolando! Ex: "Quer saber mais sobre o [Jogador]?", "Posso te contar do último campeonato?", "Mais alguma dúvida sobre nossa pantera?".
        - **Lidando com Falhas (Acontece! 😅):**
            - Se as ferramentas falharem (erro) ou não encontrarem NADA (principalmente sobre jogos): Avise que não achou a info *específica* e sugira checar fontes oficiais (HLTV, site/redes da FURIA). Seja leve! Ex: "Putz, minhas fontes tão offline pra essa info de jogo agora! 😥 Dá uma conferida rápida no HLTV ou nas redes da FURIA pra garantir!" ou "Xiii, não achei essa data/resultado aqui... melhor confirmar nos canais oficiais da Pantera! 🐾". NUNCA invente dados! #GoFURIA`;

      const messagesForAI: MessageData[] = [{ role: 'system', content: [{ text: systemInstruction }] }, ...currentHistory];
      if (messagesForAI.length > 1 && messagesForAI[1].role !== 'user') {
          console.error("CRITICAL ERROR [Flow]: History is invalid! First message after system prompt is not 'user'.", "Messages slice:", JSON.stringify(messagesForAI.slice(0, 3)));
          return "Eita! Parece que o histórico da nossa resenha deu uma bugada aqui. 😅 Manda a pergunta de novo pra eu não me perder, faz favor!";
      }

      try {
          // *** ATUALIZADO: Lista completa de ferramentas ***
          const toolsToUse = [
              getFuriaRosterTool,
              searchWikipediaTool,
              getFuriaUpcomingMatchesRapidAPITool,
              getFuriaRecentResultsRapidAPITool,
              getFuriaUpcomingMatchesLiquipediaTool,
              getFuriaRecentResultsLiquipediaTool
          ];
          console.info(`[Flow] Chamando ai.generate com ${messagesForAI.length} mensagens e ${toolsToUse.length} ferramentas.`);

          let llmResponse = await ai.generate({
              model: gemini15Flash,
              messages: messagesForAI,
              tools: toolsToUse,
              config: { temperature: 0.7 },
          });

          let attempts = 0;
          const MAX_TOOL_ATTEMPTS = 3;

          while (attempts < MAX_TOOL_ATTEMPTS) {
              const responseMessage = llmResponse.message;
              if (!responseMessage || !Array.isArray(responseMessage.content)) {
                  const directText = llmResponse.text;
                  if (directText) { console.warn("[Flow] Usando llmResponse.text pois .message ou .content é inválido/ausente."); return directText; }
                  console.error("[Flow] Resposta da IA inválida ou vazia:", llmResponse);
                  return "Oloco! Minha conexão aqui deu uma lagada sinistra e não consegui gerar a resposta. 😵 Tenta de novo aí!";
              }

              const toolRequestParts = responseMessage.content.filter(part => part.toolRequest);
              if (toolRequestParts.length === 0) {
                  const finalText = llmResponse.text;
                  console.info(`[Flow] Resposta final IA (sem ferramenta): "${finalText?.substring(0, 100)}..."`);
                  return finalText ?? "Caramba, deu branco aqui! 🤯 Não consegui formular a resposta. Pode perguntar de novo?";
              }

              attempts++;
              console.info(`[Flow] Tentativa ${attempts}/${MAX_TOOL_ATTEMPTS}: ${toolRequestParts.length} ferramenta(s) solicitada(s): ${toolRequestParts.map(part => part.toolRequest!.name).join(', ')}`);

              messagesForAI.push(responseMessage);
              const toolResponses: MessageData[] = [];

              // Processa TODAS as ferramentas solicitadas pela IA nesta rodada
              for (const part of toolRequestParts) {
                  const toolRequest = part.toolRequest;
                  if (!toolRequest) continue;

                  let output: any;
                  const toolName = toolRequest.name;
                  const inputArgs = toolRequest.input;
                  console.info(`[Flow] Executando ferramenta: ${toolName} com input:`, JSON.stringify(inputArgs));

                  let executor: Function | undefined;
                  let requiresInput = false;
                  let toolDefinition: any = undefined;

                  // *** ATUALIZADO: Mapeamento COMPLETO ***
                  if (toolName === getFuriaRosterTool.name) { executor = executeGetFuriaRoster; requiresInput = false; toolDefinition = getFuriaRosterTool; }
                  else if (toolName === searchWikipediaTool.name) { executor = executeSearchWikipedia; requiresInput = true; toolDefinition = searchWikipediaTool; }
                  else if (toolName === getFuriaUpcomingMatchesRapidAPITool.name) { executor = executeGetFuriaUpcomingMatchesRapidAPI; requiresInput = false; toolDefinition = getFuriaUpcomingMatchesRapidAPITool; }
                  else if (toolName === getFuriaRecentResultsRapidAPITool.name) { executor = executeGetFuriaRecentResultsRapidAPI; requiresInput = false; toolDefinition = getFuriaRecentResultsRapidAPITool; }
                  else if (toolName === getFuriaUpcomingMatchesLiquipediaTool.name) { executor = executeGetFuriaUpcomingMatchesLiquipedia; requiresInput = false; toolDefinition = getFuriaUpcomingMatchesLiquipediaTool; }
                  else if (toolName === getFuriaRecentResultsLiquipediaTool.name) { executor = executeGetFuriaRecentResultsLiquipedia; requiresInput = false; toolDefinition = getFuriaRecentResultsLiquipediaTool; }


                  if (executor && toolDefinition) {
                      try {
                          if (requiresInput) {
                              const validation = toolDefinition.inputSchema.safeParse(inputArgs);
                              if (!validation.success) {
                                  console.warn(`[Flow] Input inválido da IA para ${toolName}:`, inputArgs, validation.error.errors);
                                  output = { error: `Input inválido fornecido pela IA para ${toolName}: ${validation.error.errors.map((e: ZodIssue) => e.message).join(', ')}` };
                              } else {
                                  console.info(`[Flow] Input validado para ${toolName}. Executando...`);
                                  output = await executor(validation.data);
                              }
                          } else {
                              output = await executor();
                          }
                      } catch (executionError) {
                          console.error(`[Flow] Erro EXECUTANDO ferramenta ${toolName}:`, executionError);
                          output = { error: `Erro interno ao executar a ferramenta ${toolName}: ${executionError instanceof Error ? executionError.message : String(executionError)}` };
                      }
                  } else {
                      console.warn(`[Flow] Executor ou definição não encontrado para ferramenta: ${toolName}`);
                      output = { error: `Ferramenta '${toolName}' não reconhecida ou não implementada.` };
                  }

                  toolResponses.push({ role: 'tool', content: [{ toolResponse: { name: toolName, output: output } }] });
              } // Fim loop for parts

              messagesForAI.push(...toolResponses);

              console.info(`[Flow] Rechamando ai.generate com ${toolResponses.length} resposta(s) de ferramenta(s). Histórico total: ${messagesForAI.length} msgs.`);
              llmResponse = await ai.generate({ model: gemini15Flash, messages: messagesForAI, tools: toolsToUse, config: { temperature: 0.7 } });
          } // Fim loop while attempts

          console.warn("[Flow] Limite de chamadas de ferramentas atingido.");
          const lastTextFallback = llmResponse.text;
          if (lastTextFallback) { return lastTextFallback + "\n(Psst: Me embolei com as ferramentas aqui 😅, mas essa foi a última info que consegui!)"; }
          else { return "Eita, me enrolei bonito com as ferramentas aqui! 😵‍💫 Tenta perguntar de novo, talvez mais direto ao ponto?"; }

      } catch (error) {
          console.error("[Flow] Erro fatal no fluxo principal ou na geração:", error);
          let errorDetailsFallback = String(error);
          if (error instanceof Error) { errorDetailsFallback = error.message; }
          return `CRASHEI! 💥 Deu ruim aqui nos meus circuitos (${errorDetailsFallback.substring(0,50)}...). Não consegui processar. Tenta de novo daqui a pouco, por favor? 🙏`;
      }
  }
);
console.info("Flow Genkit 'furiaChatFlow' definido com lógica de ferramentas.");


// --- Configuração do Servidor Express e Webhook ---
const app = express();
app.use(express.json());
app.get('/', (_req, res) => { res.status(200).send('Servidor Bot Furia CS (Render/Redis/Genkit+googleAI) Ativo!'); });
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`;
console.info(`Configurando POST para webhook em: ${WEBHOOK_PATH}`);
app.post(WEBHOOK_PATH, async (req, res) => {
    const update: TelegramBot.Update = req.body;
    if (!update || !update.message || !update.message.chat?.id) { console.info(`[Webhook] Update ignorado (estrutura inválida ou sem ID de chat).`); res.sendStatus(200); return; }
    const chatId = update.message.chat.id;
    if (update.message.from?.is_bot) { console.info(`[Webhook] Update ignorado (mensagem de bot). Chat ${chatId}`); res.sendStatus(200); return; }
    res.sendStatus(200); // Responde OK imediatamente

    // Trata mensagens de texto
    if (update.message.text) {
        const userMessage = update.message.text.trim();
        console.info(`[Webhook] Msg chat ${chatId}: "${userMessage}"`);
        const contextKey = `genkit_history:${chatId}`;
        let historyForFlow: MessageData[] = [];
        if (redis) {
            try { /* Lógica de recuperação do Redis */ } catch (redisError) { console.error(`[Webhook] Erro leitura Redis chat ${chatId}:`, redisError); }
        }
        try {
            await bot.sendChatAction(chatId, "typing");
            const flowResult = await runFlow(furiaChatFlow, { userMessage: userMessage, chatHistory: historyForFlow });
            console.info(`[Webhook] Flow result raw: "${flowResult?.substring(0, 200)}..."`);
            const finalReply = flowResult;
            const lastUserMessage: MessageData = { role: 'user', content: [{ text: userMessage }] };
            const lastModelResponse: MessageData = { role: 'model', content: [{ text: finalReply }] };
            const finalHistoryToSave = [...historyForFlow, lastUserMessage, lastModelResponse];
            const MAX_REDIS_HISTORY_MESSAGES = 8;
            while (finalHistoryToSave.length > MAX_REDIS_HISTORY_MESSAGES) { finalHistoryToSave.shift(); }
            if (redis) {
                try { /* Lógica de salvar no Redis */ } catch (redisError) { console.error(`[Webhook] Erro ao salvar histórico no Redis chat ${chatId}:`, redisError); }
            }
            try {
                await bot.sendMessage(chatId, finalReply);
                console.info(`[Webhook] Resposta enviada para chat ${chatId}.`);
            } catch (telegramSendError) { console.error(`[Webhook] Erro ao ENVIAR mensagem via Telegram para chat ${chatId}:`, telegramSendError); }
        } catch (flowError) {
            console.error(`[Webhook] Erro GERAL ao processar mensagem ou chamar flow para chat ${chatId}:`, flowError);
            try { await bot.sendMessage(chatId, "⚠️ Putz! Deu ruim aqui na máquina! 🤖💥 Tenta mandar a pergunta de novo, por favor?"); }
            catch (sendErrorError) { console.error("[Webhook] Falha CRÍTICA ao enviar mensagem de erro final para o chat", chatId, sendErrorError); }
        }
    }
    // Trata stickers
    else if (update.message.sticker) {
        console.info(`[Webhook] Recebido sticker no chat ${chatId}. File ID: ${update.message.sticker.file_id}`);
        try { await bot.sendMessage(chatId, "Que sticker maneiro! 🤩 Mas ó, eu funciono melhor com mensagens de texto pra te ajudar com infos da FURIA, beleza? 😉"); }
        catch (error) { console.error(`[Webhook] Erro ao enviar resposta para sticker no chat ${chatId}:`, error); }
    }
    // Trata outros tipos
    else {
        const messageType = Object.keys(update.message).filter(k => !['message_id', 'from', 'chat', 'date'].includes(k))[0] || 'desconhecido';
        console.info(`[Webhook] Tipo de mensagem não suportado (${messageType}) recebido no chat ${chatId}.`);
        try { await bot.sendMessage(chatId, "Hmm, esse tipo de mensagem eu não manjo muito. 😅 Pode mandar em texto, por favor? 👍"); }
        catch (error) { console.error(`[Webhook] Erro ao enviar resposta para tipo (${messageType}) não suportado no chat ${chatId}:`, error); }
    }
});

// --- Iniciar Servidor Express ---
const port = process.env.PORT || 10000;
const host = '0.0.0.0';
const numericPort = Number(port);
if (isNaN(numericPort)) { console.error(`Porta inválida configurada: ${port}. Saindo.`); process.exit(1); }
const server = app.listen(numericPort, host, () => {
    console.info(`Servidor Express escutando em https://${host}:${numericPort}`); // Usar http para Render internamente
    console.info(`Webhook Telegram configurado para POST em: ${WEBHOOK_PATH}`);
});

// --- Encerramento Gracioso (Graceful Shutdown) ---
const gracefulShutdown = (signal: string) => {
    console.info(`${signal} signal received: closing server...`);
    server.close(async () => {
        console.info('HTTP server closed.');
        if (redis) {
            try { await redis.quit(); console.info('Redis connection closed gracefully.'); }
            catch (redisErr) { console.error('Erro ao fechar conexão Redis:', redisErr); process.exitCode = 1; }
        }
        console.info('Exiting process.');
        process.exit(); // process.exitCode será 0 se tudo ok, ou 1 se erro no redis.quit
    });
    setTimeout(() => { console.error("Could not close connections in time, forcefully shutting down"); process.exit(1); }, 10000);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
