/* eslint-disable */
// index.ts
// Código completo com CORREÇÃO do erro de atribuição TS2322.

import * as dotenv from "dotenv";
import express from "express";
import type {ZodIssue} from "zod";
import * as z from "zod";

// --- Imports Genkit ---
import {genkit, GenkitError, MessageData} from "genkit";
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
// console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'Presente' : 'AUSENTE');
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
const contactInfo = process.env.CONTACT_EMAIL || 'fallback-email@example.com'; // DEFINA CONTACT_EMAIL NO RENDER
if (!telegramToken) { console.error("Erro: TELEGRAM_BOT_TOKEN não definido!"); throw new Error("Token Telegram não configurado."); }
if (contactInfo === 'fallback-email@example.com') { console.warn("AVISO: Variável de ambiente CONTACT_EMAIL não definida. Usando fallback."); }
console.info("Token Telegram OK.");
const bot = new TelegramBot(telegramToken);
console.info("Instância Bot Telegram OK.");


// --- Inicialização do Genkit ---
console.info("Inicializando Genkit com plugin googleAI...");
const ai = genkit({
    plugins: [googleAI()],
});
console.info("Instância Genkit 'ai' criada.");


// --- Definição das Ferramentas ---

export enum TeamPlayerType { Coach = "Coach", Starter = "Starter", Substitute = "Substitute", Benched = "Benched" }

const rosterCacheSchema = z.object({
    playersInfo: z.string().optional(),
    error: z.string().optional(),
    source: z.enum(['hltv', 'liquipedia', 'cache-hltv', 'cache-liquipedia']).optional(),
});

const furiaRosterOutputSchema = z.object({
    playersInfo: z.string().optional().describe("String formatada com nome e tipo dos jogadores (ou apenas nomes se tipo não disponível). Ex: 'yuurih, KSCERATO, FalleN (Captain), molodoy, YEKINDAR (Stand-in), sidde (Coach)'"),
    error: z.string().optional().describe("Mensagem de erro se a busca falhar em todas as fontes."),
    source: z.enum(['HLTV', 'Liquipedia']).optional().describe("Fonte da informação (HLTV ou Liquipedia)."),
});

// Função de execução com fallback para Liquipedia MediaWiki API e seletores CORRIGIDOS
async function executeGetFuriaRoster(): Promise<z.infer<typeof furiaRosterOutputSchema>> {
    console.info("[Tool Exec] getFuriaRoster chamada (HLTV com fallback Liquipedia API).");
    const hltvCacheKey = "hltv:furia_roster_v3"; // Incremented cache key version
    const liquipediaCacheKey = "liquipedia:furia_roster_v3"; // Incremented cache key version
    const LIQUIPEDIA_API_URL = 'https://liquipedia.net/counterstrike/api.php';
    const LIQUIPEDIA_PAGE_NAME = 'FURIA'; // Nome correto da página
    const CUSTOM_USER_AGENT = `FuriaChatChallengeBot/1.0 (${contactInfo})`;
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
            const team = await HLTV.getTeam({ id: 8297 }); // FURIA's ID on HLTV
            if (!team?.players?.length) throw new Error("Dados/jogadores não encontrados no HLTV.");

            // Mapear players e coaches do HLTV
            const players = team.players
              .map(p => {
                  let role = '';
                  if (p.type === TeamPlayerType.Coach) role = ' (Coach)';
                  // Outras roles como Substitute, etc, podem ser adicionadas aqui se necessário
                  return p.name ? `${p.name}${role}` : null; // Adiciona role ao nome
              })
              .filter((p): p is string => p !== null); // Remove nulos

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

    // --- 2. Tentar Liquipedia API como Fallback ---
    console.info("[Liquipedia Fallback] Tentando buscar na API MediaWiki...");
    let liquipediaResult: z.infer<typeof rosterCacheSchema> | null = null;

    // 2a. Checar Cache Liquipedia
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

    // 2b. Chamar API MediaWiki da Liquipedia
    try {
        console.info(`[Liquipedia API] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME}...`);
        const response = await axios.get(LIQUIPEDIA_API_URL, {
            params: { action: 'parse', page: LIQUIPEDIA_PAGE_NAME, prop: 'text', format: 'json', disabletoc: true },
            headers: { 'User-Agent': CUSTOM_USER_AGENT, 'Accept-Encoding': 'gzip' },
            timeout: 20000
        });

        if (response.data?.error) throw new Error(`API Liquipedia retornou erro: ${response.data.error.info}`);
        const htmlContent = response.data?.parse?.text?.['*'];
        if (!htmlContent) throw new Error("Conteúdo HTML não encontrado na resposta da API Liquipedia.");

        const $ = cheerio.load(htmlContent);
        const players: string[] = [];

        // --- SELETORES LIQUIPEDIA CORRIGIDOS ---
        // 1. Encontrar o H3 com o span id="Active" (Player Roster)
        const activeHeader = $('h3 > span#Active');
        if (activeHeader.length === 0) {
            throw new Error("Não foi possível encontrar o header 'Active' do elenco de jogadores.");
        }

        // 2. Encontrar a PRIMEIRA tabela 'wikitable roster-card' DEPOIS desse header específico
        const rosterTableWrapper = activeHeader.closest('h3').nextAll('div.table-responsive.roster-card-wrapper').first();
        const rosterTable = rosterTableWrapper.find('table.wikitable.roster-card').first();

        if (rosterTable.length === 0) {
            console.error("[Liquipedia Selector] Não encontrou 'table.wikitable.roster-card' dentro de 'div.table-responsive.roster-card-wrapper' após H3#Active.");
            throw new Error("Não foi possível encontrar a tabela de elenco ('roster-card') após o header 'Active'.");
        }

        // 3. Extrair jogadores da tabela encontrada
        console.info("[Liquipedia Parser] Tabela de elenco 'Active' encontrada, processando linhas...");
        rosterTable.find('tbody tr.Player').each((_rowIndex, row) => {
            const $row = $(row);
            const playerLink = $row.find('td.ID a').first();
            let playerName: string | undefined = playerLink.attr('title'); // Prioriza o 'title'

            // Fallback para o texto do link se 'title' estiver ausente ou for inválido
            if (!playerName || playerName.includes('(page does not exist)')) {
                const fallbackName = playerLink.text().trim();
                if (fallbackName) {
                    console.warn(`[Liquipedia Parser] Usando fallback de texto para jogador: ${fallbackName}`);
                    playerName = fallbackName;
                } else {
                    console.warn("[Liquipedia Parser] Não foi possível extrair nome do jogador da linha:", $row.find('td.ID').html());
                    // CORREÇÃO TS2322: Atribuir undefined em vez de null
                    playerName = undefined; // Marca para pular este jogador
                }
            }

            if(playerName) { // Checa se playerName não é undefined ou ''
                playerName = playerName.trim();
                const playerRole = $row.find('td.Position i').text().trim();
                const playerString = playerRole ? `${playerName} ${playerRole}` : playerName;
                players.push(playerString);
            }
        });
        // --- FIM DOS SELETORES ---

        if (players.length > 0) {
            const playersInfo = players.join(', ');
            console.info("[Liquipedia API] Sucesso:", playersInfo);
            liquipediaResult = { playersInfo: playersInfo, source: 'liquipedia' };
        } else {
            console.error("[Liquipedia API] Extração de jogadores da tabela 'Active' resultou em lista vazia. Verifique seletores e HTML.");
            // console.log("HTML da tabela 'Active' processada:", rosterTable.html()); // Log para debug
            throw new Error("Extração da tabela de elenco ativa não retornou jogadores.");
        }

    } catch (scrapeErr) {
        const errorMsg = scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
        console.error("[Liquipedia API] Erro na busca ou extração:", errorMsg);
        liquipediaResult = { error: `Falha Liquipedia: ${errorMsg}`, source: 'liquipedia' };
    }

    // 2c. Cache Liquipedia Result
    if (redis && liquipediaResult) {
        try {
            const ttl = liquipediaResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            await redis.set(liquipediaCacheKey, JSON.stringify(liquipediaResult), 'EX', ttl);
            console.info(`[Cache Liquipedia] saved ${liquipediaCacheKey} (ttl: ${ttl})`);
        } catch (e) { console.error(`[Cache Liquipedia] erro save ${liquipediaCacheKey}`, e); }
    }

    // 3. Retornar resultado final
    if (liquipediaResult && !liquipediaResult.error) {
        return { playersInfo: liquipediaResult.playersInfo, source: 'Liquipedia' };
    } else {
        const hltvErrorReason = isCloudflareBlock ? "Bloqueio Cloudflare" : (hltvResult?.error || "Falha desconhecida");
        const liquipediaErrorReason = liquipediaResult?.error || "Falha desconhecida";
        const finalError = `Falha ao obter dados. HLTV: ${hltvErrorReason}. Liquipedia: ${liquipediaErrorReason}. Tente novamente mais tarde.`;
        console.error("[Tool Exec] Falha em ambas as fontes:", finalError);
        return { error: finalError };
    }
}


// Definição da ferramenta atualizada
const getFuriaRosterTool = ai.defineTool(
  {
      name: "getFuriaRoster",
      description: "Busca a escalação ATUAL de jogadores e técnico da FURIA CS2. Tenta HLTV.org primeiro, e usa a API da Liquipedia como fallback se HLTV falhar.",
      inputSchema: z.object({}),
      outputSchema: furiaRosterOutputSchema,
  },
  executeGetFuriaRoster
);

// --- Wikipedia Tool ---
const wikipediaSearchSchema = z.object({ searchTerm: z.string().describe("Termo a pesquisar na Wikipedia (nome de jogador, time, evento, etc.)") });
const wikipediaOutputSchema = z.object({
    summary: z.string().optional().describe("Resumo do artigo encontrado."),
    error: z.string().optional().describe("Mensagem de erro se a busca falhar."),
    source: z.literal('cache').or(z.literal('api')).optional(),
});
async function executeSearchWikipedia(input: z.infer<typeof wikipediaSearchSchema>): Promise<z.infer<typeof wikipediaOutputSchema>> {
    const searchTerm = input.searchTerm;
    console.info(`[Tool Exec] searchWikipedia buscando '${searchTerm}'.`);
    const cacheKey = `wiki:${searchTerm.toLowerCase().replace(/\s+/g, '_')}`;
    const CACHE_TTL_SUCCESS = 86400; // 1 day
    const CACHE_TTL_ERROR = 3600;    // 1 hour

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

        if (redis) {
            try {
                await redis.set(cacheKey, JSON.stringify(errorResult), 'EX', CACHE_TTL_ERROR);
                console.info(`[Cache Wiki] saved API error for ${searchTerm}`);
            } catch (e) { console.error(`[Cache Wiki] erro save api err ${searchTerm}`, e); }
        }
        return errorResult;
    }
}
const searchWikipediaTool = ai.defineTool(
  {
      name: "searchWikipedia",
      description: "Busca um resumo sobre um tópico na Wikipedia em Português. Use para obter informações sobre jogadores específicos (ex: FalleN, KSCERATO), times, eventos ou conceitos de CS.",
      inputSchema: wikipediaSearchSchema,
      outputSchema: wikipediaOutputSchema,
  },
  executeSearchWikipedia
);

console.info("Ferramentas Genkit definidas: getFuriaRoster (com fallback API), searchWikipedia");


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
      const { userMessage, chatHistory } = input;
      console.info(`[Flow] Mensagem: "${userMessage}" | Histórico recebido: ${chatHistory.length} msgs`);

      const validHistory: MessageData[] = chatHistory
        .map((msg: any) => {
            if (msg && typeof msg.role === 'string' && Array.isArray(msg.content)) {
                const validContent = msg.content.every((part: any) =>
                  typeof part.text === 'string' || part.toolRequest || part.toolResponse
                );
                if (validContent) {
                    return msg as MessageData;
                }
            }
            console.warn("[Flow] Mensagem inválida no histórico recebido:", msg);
            return null;
        })
        .filter((msg): msg is MessageData => msg !== null);


      const currentHistory: MessageData[] = [...validHistory];
      currentHistory.push({ role: 'user', content: [{ text: userMessage }] });

      const MAX_FLOW_HISTORY_MESSAGES = 8;
      while (currentHistory.length > MAX_FLOW_HISTORY_MESSAGES) {
          currentHistory.shift();
      }
      console.info(`[Flow] Histórico antes da IA (após adição/trim): ${currentHistory.length} msgs`);

      // PROMPT DO SISTEMA APRIMORADO
      const systemInstruction = `Você é um assistente especialista focado exclusivamente na equipe de CS2 da FURIA Esports.
        1.  Use a ferramenta 'getFuriaRoster' SEMPRE que perguntarem sobre a escalação ATUAL da FURIA.
        2.  Se o usuário perguntar sobre uma PESSOA específica (jogador, coach, staff como FalleN, KSCERATO, guerri, sidde, etc.), use a ferramenta 'searchWikipedia' PRIMEIRO para buscar informações sobre essa pessoa. Depois, formule a resposta combinando o resultado da busca com o contexto da FURIA, se aplicável.
        3.  Use 'searchWikipedia' também para buscar informações gerais sobre times, eventos ou conceitos de CS que o usuário perguntar, mas sempre relacione de volta com a FURIA se possível.
        4.  Responda APENAS sobre a FURIA CS2, seus jogadores/staff, ou tópicos diretamente relacionados. Seja conciso e direto.
        5.  Se não souber a resposta, a pergunta for sobre outro time/jogo não relacionado, ou as ferramentas falharem (retornarem erro), informe que não foi possível obter a informação específica ou que houve um problema na busca. NUNCA invente informações.
        6.  Sempre use português do Brasil.`;

      const messagesForAI: MessageData[] = [
          { role: 'system', content: [{ text: systemInstruction }] },
          ...currentHistory
      ];

      // VALIDAÇÃO DE HISTÓRICO
      if (messagesForAI.length > 1 && messagesForAI[1].role !== 'user') {
          console.error(
            "CRITICAL ERROR [Flow]: History is invalid! First message after system prompt is not 'user'.",
            "Messages slice:", JSON.stringify(messagesForAI.slice(0, 3))
          );
          return "Desculpe, houve um problema interno ao processar o histórico da conversa. Por favor, tente enviar sua mensagem novamente.";
      }
      // FIM DA VALIDAÇÃO


      try {
          console.info(`[Flow] Chamando ai.generate com ${messagesForAI.length} mensagens e ${[getFuriaRosterTool, searchWikipediaTool].length} ferramentas.`);

          let llmResponse = await ai.generate({
              model: gemini15Flash,
              messages: messagesForAI,
              tools: [getFuriaRosterTool, searchWikipediaTool],
              config: { temperature: 0.6 },
          });

          let attempts = 0;
          const MAX_TOOL_ATTEMPTS = 3;

          while (attempts < MAX_TOOL_ATTEMPTS) {
              const responseMessage = llmResponse.message;

              if (!responseMessage || !Array.isArray(responseMessage.content)) {
                  const directText = llmResponse.text;
                  if (directText) {
                      console.warn("[Flow] Usando llmResponse.text pois .message ou .content é inválido/ausente.");
                      return directText;
                  }
                  console.error("[Flow] Resposta da IA inválida ou vazia:", llmResponse);
                  return "Desculpe, não consegui processar a resposta da IA neste momento.";
              }

              const toolRequestParts = responseMessage.content.filter(part => part.toolRequest);

              if (toolRequestParts.length === 0) {
                  const finalText = llmResponse.text;
                  console.info(`[Flow] Resposta final IA (sem ferramenta): "${finalText?.substring(0, 100)}..."`);
                  return finalText ?? "Não consegui gerar uma resposta.";
              }

              attempts++;
              console.info(`[Flow] Tentativa ${attempts}/${MAX_TOOL_ATTEMPTS}: ${toolRequestParts.length} ferramenta(s) solicitada(s): ${toolRequestParts.map(part => part.toolRequest!.name).join(', ')}`);

              messagesForAI.push(responseMessage);
              const toolResponses: MessageData[] = [];

              for (const part of toolRequestParts) {
                  const toolRequest = part.toolRequest;
                  if (!toolRequest) {
                      console.warn("[Flow] Part de toolRequest inesperadamente vazia no loop, pulando.");
                      continue;
                  }

                  let output: any;
                  const toolName = toolRequest.name;
                  const inputArgs = toolRequest.input;

                  console.info(`[Flow] Executando ferramenta: ${toolName} com input:`, JSON.stringify(inputArgs));

                  let executor: Function | undefined;
                  let requiresInput = false;
                  let toolDefinition: any = undefined;

                  if (toolName === getFuriaRosterTool.name) {
                      executor = executeGetFuriaRoster;
                      requiresInput = false;
                      toolDefinition = getFuriaRosterTool;
                  } else if (toolName === searchWikipediaTool.name) {
                      executor = executeSearchWikipedia;
                      requiresInput = true;
                      toolDefinition = searchWikipediaTool;
                  }

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

                  toolResponses.push({
                      role: 'tool',
                      content: [{ toolResponse: { name: toolName, output: output } }]
                  });
              }

              messagesForAI.push(...toolResponses);

              console.info(`[Flow] Rechamando ai.generate com ${toolResponses.length} resposta(s) de ferramenta(s). Histórico total: ${messagesForAI.length} msgs.`);
              llmResponse = await ai.generate({
                  model: gemini15Flash,
                  messages: messagesForAI,
                  tools: [getFuriaRosterTool, searchWikipediaTool],
                  config: { temperature: 0.6 },
              });

          }

          console.warn("[Flow] Limite de chamadas de ferramentas atingido.");
          const lastText = llmResponse.text;
          if (lastText) {
              return lastText + "\n(Nota: Tive dificuldades em usar minhas ferramentas após várias tentativas.)";
          } else {
              return "Desculpe, tive dificuldades em processar sua solicitação usando minhas ferramentas após várias tentativas. Pode reformular sua pergunta?";
          }


      } catch (error) {
          console.error("[Flow] Erro fatal no fluxo principal ou na geração:", error);
          let errorDetails: string;
          if (error instanceof GenkitError) {
              errorDetails = `${error.name}: ${error.message} (Status: ${error.status}, Causa: ${error.cause instanceof Error ? error.cause.message : error.cause})`;
          } else if (error instanceof Error) {
              errorDetails = `${error.name}: ${error.message}`;
          } else {
              errorDetails = String(error);
          }
          return `Desculpe, ocorreu um problema interno inesperado ao processar sua solicitação (${errorDetails.substring(0,100)}...). Por favor, tente novamente mais tarde.`;
      }
  }
);
console.info("Flow Genkit 'furiaChatFlow' definido com lógica de ferramentas.");


// --- Configuração do Servidor Express ---
const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
    res.status(200).send('Servidor Bot Furia CS (Render/Redis/Genkit+googleAI) Ativo!');
});

// --- Rota do Webhook Telegram ---
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`;
console.info(`Configurando POST para webhook em: ${WEBHOOK_PATH}`);

app.post(WEBHOOK_PATH, async (req, res) => {
    const update: TelegramBot.Update = req.body;

    if (!update || !update.message || !update.message.text || !update.message.chat?.id) {
        console.info(`[Webhook] Update ignorado (estrutura inválida ou sem texto/ID).`);
        res.sendStatus(200);
        return;
    }
    if (update.message.from?.is_bot) {
        console.info(`[Webhook] Update ignorado (mensagem de bot).`);
        res.sendStatus(200);
        return;
    }

    const chatId = update.message.chat.id;
    const userMessage = update.message.text.trim();
    console.info(`[Webhook] Msg chat ${chatId}: "${userMessage}"`);

    res.sendStatus(200);

    const contextKey = `genkit_history:${chatId}`;
    let historyForFlow: MessageData[] = [];

    if (redis) {
        try {
            const storedHistory = await redis.get(contextKey);
            if (storedHistory) {
                try {
                    const parsedHistory = JSON.parse(storedHistory);
                    if (Array.isArray(parsedHistory)) {
                        historyForFlow = parsedHistory.filter(msg =>
                          msg && typeof msg.role === 'string' && Array.isArray(msg.content)
                        );
                        console.info(`[Webhook] Histórico Genkit recuperado Redis chat ${chatId} (${historyForFlow.length} msgs válidas)`);
                    } else {
                        console.warn(`[Webhook] Histórico Genkit inválido (não é array) Redis chat ${chatId}. Ignorando.`);
                        await redis.del(contextKey);
                    }
                } catch (parseError) {
                    console.warn(`[Webhook] Erro ao parsear histórico Genkit Redis chat ${chatId}. Ignorando.`, parseError);
                    await redis.del(contextKey);
                }
            } else {
                console.info(`[Webhook] Histórico não encontrado no Redis para chat ${chatId}.`);
            }
        } catch (redisError) {
            console.error(`[Webhook] Erro leitura Redis chat ${chatId}:`, redisError);
        }
    }

    try {
        await bot.sendChatAction(chatId, "typing");

        const flowResult = await runFlow(furiaChatFlow, {
            userMessage: userMessage,
            chatHistory: historyForFlow
        });

        console.info(`[Webhook] Flow result raw: "${flowResult?.substring(0, 200)}..."`);

        const finalReply = flowResult;

        const lastUserMessage: MessageData = { role: 'user', content: [{ text: userMessage }] };
        const lastModelResponse: MessageData = { role: 'model', content: [{ text: finalReply }] };
        const finalHistoryToSave = [...historyForFlow, lastUserMessage, lastModelResponse];
        const MAX_REDIS_HISTORY_MESSAGES = 8;
        while (finalHistoryToSave.length > MAX_REDIS_HISTORY_MESSAGES) {
            finalHistoryToSave.shift();
        }

        if (redis) {
            try {
                await redis.set(contextKey, JSON.stringify(finalHistoryToSave), 'EX', 60 * 30);
                console.info(`[Webhook] Histórico Genkit (${finalHistoryToSave.length} msgs) salvo no Redis para chat ${chatId}`);
            } catch (redisError) {
                console.error(`[Webhook] Erro ao salvar histórico no Redis chat ${chatId}:`, redisError);
            }
        }

        try {
            await bot.sendMessage(chatId, finalReply, { parse_mode: 'Markdown' });
            console.info(`[Webhook] Resposta enviada para chat ${chatId}.`);
        } catch (telegramSendError) {
            console.error(`[Webhook] Erro ao ENVIAR mensagem via Telegram para chat ${chatId}:`, telegramSendError);
        }


    } catch (flowError) {
        console.error(`[Webhook] Erro GERAL ao processar mensagem ou chamar flow para chat ${chatId}:`, flowError);
        try {
            await bot.sendMessage(chatId, "⚠️ Desculpe, ocorreu um erro inesperado ao processar sua mensagem. Por favor, tente novamente.");
        } catch (sendErrorError) {
            console.error("[Webhook] Falha CRÍTICA ao enviar mensagem de erro final para o chat", chatId, sendErrorError);
        }
    }
});


// --- Iniciar Servidor Express ---
const port = process.env.PORT || 10000;
const host = '0.0.0.0';
const numericPort = Number(port);

if (isNaN(numericPort)) {
    console.error(`Porta inválida configurada: ${port}. Saindo.`);
    process.exit(1);
}

const server = app.listen(numericPort, host, () => {
    console.info(`Servidor Express escutando em https://${host}:${numericPort}`);
    console.info(`Webhook Telegram configurado para POST em: ${WEBHOOK_PATH}`);
});

// --- Encerramento Gracioso (Graceful Shutdown) ---
const gracefulShutdown = (signal: string) => {
    console.info(`${signal} signal received: closing server...`);
    server.close(async () => {
        console.info('HTTP server closed.');
        if (redis) {
            try {
                await redis.quit();
                console.info('Redis connection closed gracefully.');
            } catch (redisErr) {
                console.error('Erro ao fechar conexão Redis:', redisErr);
                process.exitCode = 1;
            }
        }
        console.info('Exiting process.');
        process.exit();
    });

    setTimeout(() => {
        console.error("Could not close connections in time, forcefully shutting down");
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
