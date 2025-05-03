/* eslint-disable */
// index.ts
// Tentativa 13: Fallback para Liquipedia MediaWiki API se HLTV falhar

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
// Adicione um console.log para a chave Gemini aqui se precisar depurar
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
const contactInfo = process.env.CONTACT_EMAIL || 'responsible-dev@example.com'; // Use uma variável de ambiente ou um email real
if (!telegramToken) { console.error("Erro: TELEGRAM_BOT_TOKEN não definido!"); throw new Error("Token Telegram não configurado."); }
console.info("Token Telegram OK.");
const bot = new TelegramBot(telegramToken);
console.info("Instância Bot Telegram OK.");


// --- Inicialização do Genkit ---
console.info("Inicializando Genkit com plugin googleAI...");
const ai = genkit({
    plugins: [ googleAI() ], // Certifique-se que GEMINI_API_KEY está no ambiente
});
console.info("Instância Genkit 'ai' criada.");


// --- Definição das Ferramentas (Usando ai.defineTool) ---

export enum TeamPlayerType { Coach = "Coach", Starter = "Starter", Substitute = "Substitute", Benched = "Benched" }

// Schema para cache (inclui fonte)
const rosterCacheSchema = z.object({
    playersInfo: z.string().optional(),
    error: z.string().optional(),
    source: z.enum(['hltv', 'liquipedia', 'cache-hltv', 'cache-liquipedia']).optional(),
});

// Schema para output da ferramenta (interface para o LLM)
const furiaRosterOutputSchema = z.object({
    playersInfo: z.string().optional().describe("String formatada com nome e tipo dos jogadores (ou apenas nomes se tipo não disponível)."),
    error: z.string().optional().describe("Mensagem de erro se a busca falhar em todas as fontes."),
    source: z.enum(['HLTV', 'Liquipedia']).optional().describe("Fonte da informação (HLTV ou Liquipedia)."),
});

// Função de execução com fallback para Liquipedia MediaWiki API
async function executeGetFuriaRoster(): Promise<z.infer<typeof furiaRosterOutputSchema>> {
    console.info("[Tool Exec] getFuriaRoster chamada (HLTV com fallback Liquipedia API).");
    const hltvCacheKey = "hltv:furia_roster_v2"; // Incrementa versão se mudar lógica/schema
    const liquipediaCacheKey = "liquipedia:furia_roster_v2";
    const LIQUIPEDIA_API_URL = 'https://liquipedia.net/counterstrike/api.php';
    const LIQUIPEDIA_PAGE_NAME = 'FURIA_Esports';
    const CUSTOM_USER_AGENT = `FuriaChatChallengeBot/1.0 (${contactInfo})`; // User-Agent customizado
    const CACHE_TTL_SUCCESS = 14400; // 4 hours
    const CACHE_TTL_ERROR = 3600;    // 1 hour

    // --- 1. Tentar HLTV (Cache ou API) ---
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

    // 1b. Tentar API HLTV (Apenas se cache miss ou erro não-CF cacheado)
    if (!isCloudflareBlock) {
        console.info("[HLTV API] Tentando buscar dados...");
        try {
            const team = await HLTV.getTeam({ id: 8297 }); // ID da FURIA
            if (!team?.players?.length) throw new Error("Dados/jogadores não encontrados no HLTV.");

            const players = team.players
              .map(p => ({ name: p.name || 'N/A', type: Object.values(TeamPlayerType).includes(p.type as TeamPlayerType) ? p.type as TeamPlayerType : TeamPlayerType.Starter }))
              .filter(p => p.name !== 'N/A');
            if (players.length === 0) throw new Error("Nenhum jogador válido encontrado no HLTV.");

            const playersInfo = players.map(p => `${p.name} (${p.type})`).join(', ');
            console.info(`[HLTV API] Sucesso: ${playersInfo}`);
            hltvResult = { playersInfo: playersInfo, source: 'hltv' };
            if (redis) { // Cache Success
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
            if (redis) { // Cache Error
                try { await redis.set(hltvCacheKey, JSON.stringify(hltvResult), 'EX', CACHE_TTL_ERROR); }
                catch (e) { console.error(`[Cache HLTV] erro save error ${hltvCacheKey}`, e); }
            }
            if (!isCloudflareBlock) {
                return { error: hltvResult.error }; // Retorna erro não-CF
            }
            // Se for Cloudflare block, continua para o fallback
        }
    } else {
        console.warn("[HLTV] Bloqueio Cloudflare detectado (do cache ou tentativa anterior), pulando para Liquipedia.");
    }

    // --- 2. Tentar Liquipedia API como Fallback ---
    console.info("[Liquipedia Fallback] Tentando buscar na API MediaWiki...");
    let liquipediaResult: z.infer<typeof rosterCacheSchema> | null = null;

    // 2a. Checar Cache Liquipedia
    if (redis) {
        try {
            const cachedData = await redis.get(liquipediaCacheKey);
            if (cachedData) {
                const parsedCache = rosterCacheSchema.parse(JSON.parse(cachedData));
                if (parsedCache && !parsedCache.error) {
                    console.info(`[Cache Liquipedia] hit ${liquipediaCacheKey}`);
                    return { playersInfo: parsedCache.playersInfo, source: 'Liquipedia' };
                } else if (parsedCache?.error) {
                    console.warn(`[Cache Liquipedia] hit com erro ${liquipediaCacheKey}. Tentando buscar novamente.`);
                }
            } else { console.info(`[Cache Liquipedia] miss ${liquipediaCacheKey}`); }
        } catch (e) { console.error(`[Cache Liquipedia] erro read ${liquipediaCacheKey}`, e); }
    }

    // 2b. Chamar API MediaWiki da Liquipedia
    try {
        console.info(`[Liquipedia API] Buscando action=parse para ${LIQUIPEDIA_PAGE_NAME}...`);
        const response = await axios.get(LIQUIPEDIA_API_URL, {
            params: {
                action: 'parse',
                page: LIQUIPEDIA_PAGE_NAME,
                prop: 'text', // Queremos o HTML do conteúdo
                format: 'json',
                disabletoc: true, // Não precisamos do índice
                // section: 2, // Opcional: Tentar pegar só a seção do time se o índice for estável (requer teste)
            },
            headers: {
                'User-Agent': CUSTOM_USER_AGENT, // Exigido pelos Termos de Uso
                'Accept-Encoding': 'gzip', // Exigido pelos Termos de Uso
            },
            timeout: 20000 // Timeout maior para API parse
        });

        if (response.data?.error) {
            throw new Error(`API Liquipedia retornou erro: ${response.data.error.info}`);
        }

        const htmlContent = response.data?.parse?.text?.['*'];
        if (!htmlContent) {
            throw new Error("Conteúdo HTML não encontrado na resposta da API Liquipedia.");
        }

        const $ = cheerio.load(htmlContent);
        const players: string[] = [];

        // --- !!! SELETOR CRÍTICO PARA O HTML DA API !!! ---
        // Tenta encontrar a tabela do time ativo DENTRO DO HTML RETORNADO PELA API
        const activeSquadHeading = $('#Active_Squad'); // Procura H2 com ID 'Active_Squad'
        let rosterTable = activeSquadHeading.parent().nextAll('table.wikitable').first();

        if (rosterTable.length === 0) {
            console.warn("Seletor pós H2 falhou na API, tentando por div.roster-card...");
            // O HTML da API pode não ter divs .roster-card, buscar tabelas wikitable diretamente
            rosterTable = $('table.wikitable').filter((_i, el) => {
                // Heurística: verificar se a primeira linha (cabeçalho) contém 'ID' ou 'Player'
                const thText = $(el).find('thead tr th').first().text().trim().toLowerCase();
                return thText === 'id' || thText === 'player';
            }).first();
        }

        if (rosterTable.length > 0) {
            console.info("Tabela do elenco encontrada na resposta da API Liquipedia, extraindo jogadores...");
            rosterTable.find('tbody tr').each((_i, row) => {
                const playerCell = $(row).find('td').first(); // Primeira célula
                const playerLink = playerCell.find('a').first(); // Link dentro da célula
                let playerName = playerLink.attr('title') || playerCell.text().trim(); // Prefere o title do link

                if (playerName && !playerName.includes('(page does not exist)')) {
                    // Remover possíveis qualificadores extras como "(Captain)" se existirem
                    playerName = playerName.replace(/\s*\(.*?\)\s*$/, '').trim();
                    if (playerName) { // Checa se sobrou nome após remover qualificadores
                        players.push(playerName);
                    }
                }
            });
        } else {
            console.warn("Não foi possível encontrar a tabela do elenco na resposta da API Liquipedia com os seletores.");
        }
        // --- !!! FIM DO SELETOR CRÍTICO !!! ---

        if (players.length > 0) {
            const playersInfo = players.join(', ');
            console.info("[Liquipedia API] Sucesso:", playersInfo);
            liquipediaResult = { playersInfo: playersInfo, source: 'liquipedia' };
        } else {
            throw new Error("Não foi possível extrair jogadores da Liquipedia (verificar seletores ou estrutura da página na API).");
        }

    } catch (scrapeErr) {
        const errorMsg = scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
        console.error("[Liquipedia API] Erro:", errorMsg);
        liquipediaResult = { error: `Falha ao buscar/processar API Liquipedia: ${errorMsg}`, source: 'liquipedia' };
    }

    // 2c. Cache Liquipedia Result
    if (redis && liquipediaResult) {
        try {
            const ttl = liquipediaResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            await redis.set(liquipediaCacheKey, JSON.stringify(liquipediaResult), 'EX', ttl);
            console.info(`[Cache Liquipedia] saved ${liquipediaCacheKey} (ttl: ${ttl})`);
        } catch (e) { console.error(`[Cache Liquipedia] erro save ${liquipediaCacheKey}`, e); }
    }

    // 3. Retornar resultado da Liquipedia (sucesso ou erro)
    if (liquipediaResult && !liquipediaResult.error) {
        return { playersInfo: liquipediaResult.playersInfo, source: 'Liquipedia' };
    } else {
        // Se AMBOS falharam (HLTV por Cloudflare, Liquipedia por erro)
        return { error: `Falha ao obter dados do HLTV (Bloqueio Cloudflare) e da Liquipedia (${liquipediaResult?.error || 'Erro desconhecido'}). Tente novamente mais tarde.` };
    }
}
// Atualiza a descrição da ferramenta
const getFuriaRosterTool = ai.defineTool(
  {
      name: "getFuriaRoster",
      description: "Busca a escalação ATUAL de jogadores da FURIA CS2. Tenta HLTV.org primeiro, e usa a API da Liquipedia como fallback se HLTV estiver inacessível.",
      inputSchema: z.object({}),
      outputSchema: furiaRosterOutputSchema,
  },
  executeGetFuriaRoster
);


// --- Wikipedia Tool (sem alterações) ---
const wikipediaSearchSchema = z.object({ searchTerm: z.string().describe("Termo a pesquisar") });
const wikipediaOutputSchema = z.object({
    summary: z.string().optional().describe("Resumo do artigo."),
    error: z.string().optional(),
    source: z.literal('cache').or(z.literal('api')).optional(),
});
async function executeSearchWikipedia(input: z.infer<typeof wikipediaSearchSchema>): Promise<z.infer<typeof wikipediaOutputSchema>> {
    const searchTerm = input.searchTerm;
    console.info(`[Tool Exec] searchWikipedia buscando '${searchTerm}'.`);
    const cacheKey = `wiki:${searchTerm.toLowerCase()}`;

    if (redis) {
        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                const parsedCache = JSON.parse(cachedData);
                const validation = wikipediaOutputSchema.safeParse(parsedCache);
                if (validation.success) {
                    if (validation.data.summary) {
                        console.info(`[Cache] hit ${searchTerm}`);
                        return { ...validation.data, source: 'cache' };
                    }
                    if (validation.data.error) console.warn(`[Cache] Erro cacheado ${searchTerm}`);
                } else {
                    console.warn(`[Cache] Invalid data for ${searchTerm}, fetching again.`);
                }
            } else {
                console.info(`[Cache] miss ${searchTerm}`);
            }
        } catch (e) { console.error(`[Cache] erro read ${searchTerm}`, e); }
    }

    try {
        wiki.setLang('pt');
        const page = await wiki.page(searchTerm, { autoSuggest: true });
        let apiResult: z.infer<typeof wikipediaOutputSchema>;
        if (!page) {
            apiResult = { error: `Página '${searchTerm}' não encontrada.` };
        } else {
            const summaryResult = await page.summary();
            if (!summaryResult?.extract) {
                apiResult = { error: `Resumo vazio para ${searchTerm}.` };
            } else {
                apiResult = { summary: summaryResult.extract, source: 'api' };
                console.info(`[Tool Exec] Resumo wiki obtido para ${searchTerm}.`);
            }
        }

        if (redis) {
            try {
                const ttl = apiResult.error ? 3600 : 86400;
                await redis.set(cacheKey, JSON.stringify(apiResult), 'EX', ttl);
                console.info(`[Cache] saved ${searchTerm} (ttl: ${ttl})`);
            } catch (e) { console.error(`[Cache] erro save ${searchTerm}`, e); }
        }
        return apiResult;

    } catch (err) {
        console.error(`[Tool Exec] searchWikipedia Erro API ${searchTerm}: ${err}`);
        const msg = err instanceof Error ? err.message : "Erro desconhecido na API Wikipedia";
        let errorMsg = `Erro ao buscar '${searchTerm}' na Wikipedia: ${msg}`;
        if (String(err).includes('No article found')) {
            errorMsg = `Artigo '${searchTerm}' não encontrado na Wikipedia.`;
        }
        const errorResult = { error: errorMsg };

        if (redis) {
            try {
                await redis.set(cacheKey, JSON.stringify(errorResult), 'EX', 3600);
                console.info(`[Cache] saved API error for ${searchTerm}`);
            } catch (e) { console.error(`[Cache] erro save api err ${searchTerm}`, e); }
        }
        return errorResult;
    }
}
const searchWikipediaTool = ai.defineTool(
  {
      name: "searchWikipedia",
      description: "Busca um resumo sobre um tópico na Wikipedia em Português.",
      inputSchema: wikipediaSearchSchema,
      outputSchema: wikipediaOutputSchema,
  },
  executeSearchWikipedia
);

console.info("Ferramentas Genkit definidas: getFuriaRoster (com fallback API), searchWikipedia");


// --- Definição do Flow Principal do Chat (sem alterações) ---
const flowInputSchema = z.object({
    userMessage: z.string(),
    chatHistory: z.array(z.any()).optional().default([]),
});

const furiaChatFlow = defineFlow(
  {
      name: "furiaChatFlow",
      inputSchema: flowInputSchema,
      outputSchema: z.string().describe("Resposta final do assistente"),
  },
  async (input): Promise<string> => {
      const { userMessage, chatHistory } = input;
      console.info(`[Flow] Mensagem: "${userMessage}" | Histórico: ${chatHistory.length} msgs`);

      const currentHistory: MessageData[] = [...(chatHistory as MessageData[])];
      currentHistory.push({ role: 'user', content: [{ text: userMessage }] });

      const MAX_FLOW_HISTORY_PAIRS = 4;
      while (currentHistory.length > MAX_FLOW_HISTORY_PAIRS * 2) {
          currentHistory.shift();
      }
      console.info(`[Flow] Histórico após adição/trim: ${currentHistory.length} msgs`);

      const systemInstruction = `Você é um assistente especialista focado exclusivamente na equipe de CS2 da FURIA Esports. Use as ferramentas disponíveis para buscar informações ATUALIZADAS quando necessário (escalação, resultados recentes, etc.). Responda APENAS sobre a FURIA CS2. Seja conciso e direto. Se não souber ou a pergunta for sobre outro time/jogo, diga que não tem essa informação. Sempre use português do Brasil.`;

      const messagesForAI: MessageData[] = [
          { role: 'system', content: [{ text: systemInstruction }] },
          ...currentHistory
      ];

      try {
          console.info(`[Flow] Chamando ai.generate com ${messagesForAI.length} mensagens e 2 ferramentas.`);

          let llmResponse = await ai.generate({
              model: gemini15Flash,
              messages: messagesForAI,
              tools: [getFuriaRosterTool, searchWikipediaTool],
              config: { temperature: 0.7 },
          });

          let attempts = 0;
          const MAX_TOOL_ATTEMPTS = 5;

          while (attempts < MAX_TOOL_ATTEMPTS) {
              const responseMessage = llmResponse.message;
              if (!responseMessage) {
                  const directText = llmResponse.text;
                  if(directText) {
                      console.warn("[Flow] Usando llmResponse.text diretamente pois .message não foi encontrado.");
                      return directText;
                  }
                  console.error("[Flow] Resposta da IA inválida, sem message ou text.");
                  return "Desculpe, não consegui processar a resposta da IA.";
              }

              const toolRequestParts = responseMessage.content.filter(
                (part: any) => !!part.toolRequest
              );

              if (toolRequestParts.length === 0) {
                  const finalText = llmResponse.text;
                  console.info(`[Flow] Resposta final IA: "${finalText?.substring(0,100)}..."`);
                  return finalText ?? "Não consegui gerar uma resposta.";
              }

              attempts++;
              console.info(`[Flow] Tentativa ${attempts}: ${toolRequestParts.length} ferramenta(s) solicitada(s): ${toolRequestParts.map((part: any) => part.toolRequest.name).join(', ')}`);

              const toolResponses: MessageData[] = [];
              messagesForAI.push(responseMessage);

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
                                  console.warn(`[Flow] Input inválido IA para ${toolName}:`, inputArgs, validation.error.errors);
                                  output = { error: `Input inválido fornecido pela IA para ${toolName}: ${validation.error.errors.map((e: ZodIssue) => e.message).join(', ')}` };
                              } else {
                                  console.info(`[Flow] Input validado para ${toolName}. Executando...`);
                                  output = await executor(validation.data);
                              }
                          } else {
                              output = await executor();
                          }
                      } catch (executionError) {
                          console.error(`[Flow] Erro executando ${toolName}:`, executionError);
                          output = { error: `Erro interno ao executar ${toolName}: ${executionError instanceof Error ? executionError.message : String(executionError)}` };
                      }
                  } else {
                      console.warn(`[Flow] Executor ou definição não encontrado para: ${toolName}`);
                      output = { error: `Executor ou definição não encontrado para ferramenta ${toolName}.` };
                  }

                  toolResponses.push({
                      role: 'tool',
                      content: [{ toolResponse: { name: toolName, output: output } }]
                  });
              }

              messagesForAI.push(...toolResponses);

              console.info(`[Flow] Rechamando ai.generate com ${toolResponses.length} respostas de ferramentas.`);
              llmResponse = await ai.generate({
                  model: gemini15Flash,
                  messages: messagesForAI,
                  tools: [getFuriaRosterTool, searchWikipediaTool],
                  config: { temperature: 0.7 },
              });
          }

          console.warn("[Flow] Limite de chamadas de ferramentas atingido.");
          return llmResponse.text ?? "Tive dificuldades em usar minhas ferramentas após várias tentativas. Pode reformular?";

      } catch (error) {
          console.error("[Flow] Erro no fluxo principal ou na geração:", error);
          let errorDetails = String(error);
          if (error instanceof GenkitError) {
              errorDetails = `${error.message} (Status: ${error.status}, Detail: ${error.detail ?? 'N/A'})`;
          } else if (error instanceof Error) { errorDetails = error.message; }
          return `Desculpe, tive um problema interno (${errorDetails}).`;
      }
  }
);
console.info("Flow Genkit 'furiaChatFlow' definido com lógica de ferramentas.");


// --- Configuração do Servidor Express (sem alterações) ---
const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
    res.status(200).send('Servidor Bot Furia CS (Render/Redis/Genkit+googleAI) Ativo!');
});

// --- Rota do Webhook Telegram (sem alterações) ---
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`;
console.info(`Configurando POST para webhook em: ${WEBHOOK_PATH}`);

app.post(WEBHOOK_PATH, async (req, res) => {
    const update: TelegramBot.Update = req.body;
    if (update.message?.text && update.message.chat?.id) {
        const chatId = update.message.chat.id;
        const userMessage = update.message.text;
        if (update.message.from?.is_bot) {
            res.sendStatus(200);
            return;
        }
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
                            console.info(`[Webhook] Histórico Genkit recuperado Redis chat ${chatId} (${historyForFlow.length} msgs)`);
                        } else {
                            console.warn(`[Webhook] Histórico Genkit inválido Redis chat ${chatId}. Ignorando.`);
                        }
                    } catch (parseError) {
                        console.warn(`[Webhook] Histórico Genkit inválido Redis chat ${chatId}. Ignorando.`, parseError);
                    }
                }
            } catch (redisError) {
                console.error(`[Webhook] Erro leitura Redis chat ${chatId}:`, redisError);
            }
        }

        try {
            await bot.sendChatAction(chatId, "typing");

            // Use runFlow
            const flowResult = await runFlow(furiaChatFlow, {
                userMessage: userMessage,
                chatHistory: historyForFlow
            });

            console.info(`[Webhook] Flow result raw: ${JSON.stringify(flowResult)}`);

            const finalReply = typeof flowResult === 'string' ? flowResult : "Desculpe, não obtive uma resposta clara do assistente.";

            const lastUser: MessageData = { role: 'user', content: [{ text: userMessage }] };
            const lastModel: MessageData = { role: 'model', content: [{ text: finalReply }] };
            const finalHistoryToSave = [...historyForFlow, lastUser, lastModel];
            const MAX_REDIS_HISTORY_PAIRS = 4;
            while (finalHistoryToSave.length > MAX_REDIS_HISTORY_PAIRS * 2) {
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

            await bot.sendMessage(chatId, finalReply, { parse_mode: 'Markdown' });
            console.info(`[Webhook] Resposta enviada para chat ${chatId}.`);

        } catch (error) {
            console.error(`[Webhook] Erro ao processar / chamar flow para chat ${chatId}:`, error);
            try {
                await bot.sendMessage(chatId, "⚠️ Erro interno ao processar sua mensagem.");
            } catch (e) {
                console.error("Falha ao enviar erro final", e);
            }
        }
        return;

    } else {
        console.info(`[Webhook] Update ignorado (sem texto ou ID).`);
        res.sendStatus(200);
        return;
    }
});


// --- Iniciar Servidor Express (sem alterações) ---
const port = process.env.PORT || 8080;
const host = '0.0.0.0';
const numericPort = Number(port);

if (isNaN(numericPort)) { console.error(`Porta inválida: ${port}.`); process.exit(1); }

const server = app.listen(numericPort, host, () => {
    console.info(`Servidor Express escutando em https://${host}:${numericPort}`);
    console.info(`Webhook Telegram esperado em: ${WEBHOOK_PATH}`);
});

// --- Encerramento Gracioso (sem alterações) ---
const gracefulShutdown = (signal: string) => {
    console.info(`${signal} signal received: closing server...`);
    server.close(() => {
        console.info('HTTP server closed.');
        if (redis) {
            redis.quit((err, reply) => {
                if (err) {
                    console.error('Erro ao fechar conexão Redis:', err);
                    process.exit(1);
                } else {
                    console.info('Redis connection closed gracefully:', reply);
                    process.exit(0);
                }
            });
            setTimeout(() => {
                console.warn('Redis quit timed out, forcing exit.');
                process.exit(1);
            }, 5000);
        } else {
            process.exit(0);
        }
    });
    setTimeout(() => {
        console.error("Could not close connections in time, forcefully shutting down");
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
