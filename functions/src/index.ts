/* eslint-disable */
// index.ts
// Tentativa 11.1: Melhorar mensagem de erro Cloudflare

import * as dotenv from "dotenv";
import express from "express";
import type {ZodIssue} from "zod"; // Use type import
import * as z from "zod";
// --- Imports Genkit ---
import {genkit, GenkitError, MessageData} from "genkit";
import {gemini15Flash, googleAI} from "@genkit-ai/googleai";
// Import defineFlow AND runFlow from @genkit-ai/flow
import {defineFlow, runFlow} from "@genkit-ai/flow";

// --- Imports das Ferramentas e Outros ---
import HLTV from "hltv";
import wiki from "wikipedia";
import * as path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import Redis from "ioredis";

// --- Carregamento de Variáveis de Ambiente ---
dotenv.config({ path: path.resolve(__dirname, '../.env') });
console.log('--- DEBUG ENV VARS ---');
// ... console logs ...
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
if (!telegramToken) { console.error("Erro: TELEGRAM_BOT_TOKEN não definido!"); throw new Error("Token Telegram não configurado."); }
console.info("Token Telegram OK.");
const bot = new TelegramBot(telegramToken);
console.info("Instância Bot Telegram OK.");


// --- Inicialização do Genkit ---
console.info("Inicializando Genkit com plugin googleAI...");
const ai = genkit({
    plugins: [ googleAI() ],
});
console.info("Instância Genkit 'ai' criada.");


// --- Definição das Ferramentas (Usando ai.defineTool) ---

export enum TeamPlayerType { Coach = "Coach", Starter = "Starter", Substitute = "Substitute", Benched = "Benched" }

// Schema para cache (inclui source)
const furiaRosterCacheSchema = z.object({
    playersInfo: z.string().optional(),
    error: z.string().optional(),
    source: z.literal('cache').or(z.literal('api')).optional(),
});

// Schema para output da ferramenta (não inclui source)
const furiaRosterOutputSchema = z.object({
    playersInfo: z.string().optional().describe("String formatada com nome e tipo dos jogadores."),
    error: z.string().optional(),
});

// Função de execução HLTV com cache e melhor msg de erro
async function executeGetFuriaRoster(): Promise<z.infer<typeof furiaRosterOutputSchema>> {
    console.info("[Tool Exec] getFuriaRoster chamada.");
    const cacheKey = "hltv:furia_roster";
    const CACHE_TTL_SUCCESS = 14400; // 4 hours
    const CACHE_TTL_ERROR = 3600;    // 1 hour

    // 1. Check Cache
    if (redis) {
        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                const parsedCache = JSON.parse(cachedData);
                const validation = furiaRosterCacheSchema.safeParse(parsedCache);
                if (validation.success) {
                    console.info(`[Cache] hit ${cacheKey}`);
                    // Return the structure expected by the tool definition
                    return { playersInfo: validation.data.playersInfo, error: validation.data.error };
                } else {
                    console.warn(`[Cache] Invalid data for ${cacheKey}, fetching again.`);
                }
            } else {
                console.info(`[Cache] miss ${cacheKey}`);
            }
        } catch (e) {
            console.error(`[Cache] erro read ${cacheKey}`, e);
        }
    }

    // 2. Call API if cache miss or invalid
    let apiResult: z.infer<typeof furiaRosterOutputSchema>;
    try {
        const team = await HLTV.getTeam({ id: 8297 });
        if (!team || !team.players || team.players.length === 0) {
            apiResult = { error: "Dados da equipe FURIA ou jogadores não encontrados no HLTV." };
        } else {
            const players = team.players
              .map(p => ({ name: p.name || 'N/A', type: Object.values(TeamPlayerType).includes(p.type as TeamPlayerType) ? p.type as TeamPlayerType : TeamPlayerType.Starter }))
              .filter(p => p.name !== 'N/A');
            if (players.length === 0) {
                apiResult = { error: "Nenhum jogador válido encontrado para FURIA." };
            } else {
                console.info(`[Tool Exec] Jogadores HLTV: ${players.map(p => p.name).join(', ')}`);
                apiResult = { playersInfo: players.map(p => `${p.name} (${p.type})`).join(', ') };
            }
        }
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[Tool Exec] getFuriaRoster Erro API:", errorMsg);
        // *** IMPROVED ERROR MESSAGE HANDLING ***
        if (errorMsg.includes('Cloudflare') || errorMsg.includes('Access denied')) {
            apiResult = { error: `Não consegui acessar os dados do HLTV no momento (possível bloqueio Cloudflare). Tente novamente mais tarde.` };
        } else {
            apiResult = { error: `Erro ao buscar no HLTV: ${errorMsg}` };
        }
        // **************************************
    }

    // 3. Write to Cache
    if (redis) {
        try {
            const ttl = apiResult.error ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            const dataToCache: z.infer<typeof furiaRosterCacheSchema> = { ...apiResult, source: 'api' };
            await redis.set(cacheKey, JSON.stringify(dataToCache), 'EX', ttl);
            console.info(`[Cache] saved ${cacheKey} (ttl: ${ttl})`);
        } catch (e) {
            console.error(`[Cache] erro save ${cacheKey}`, e);
        }
    }

    // 4. Return API result (original schema)
    return apiResult;
}
// Define the tool using the ai instance
const getFuriaRosterTool = ai.defineTool(
  {
      name: "getFuriaRoster",
      description: "Busca a escalação ATUAL de jogadores da FURIA CS2 no HLTV.org.",
      inputSchema: z.object({}),
      outputSchema: furiaRosterOutputSchema, // Tool output doesn't include 'source'
  },
  executeGetFuriaRoster
);

// --- Wikipedia Tool (remains the same) ---
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
      outputSchema: wikipediaOutputSchema, // Wikipedia function returns source, so schema matches
  },
  executeSearchWikipedia
);

console.info("Ferramentas Genkit definidas: getFuriaRoster, searchWikipedia");


// --- Definição do Flow Principal do Chat ---
const flowInputSchema = z.object({
    userMessage: z.string(),
    chatHistory: z.array(z.any()).optional().default([]),
});

// Let TypeScript infer the flow type
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
                  let toolDefinition: any = undefined; // Using 'any' for simplicity

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

            // Use runFlow from @genkit-ai/flow
            const flowResult = await runFlow(furiaChatFlow, {
                userMessage: userMessage,
                chatHistory: historyForFlow
            });

            console.info(`[Webhook] Flow result raw: ${JSON.stringify(flowResult)}`);

            const finalReply = true ? flowResult : "Desculpe, não obtive uma resposta clara do assistente.";

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


// --- Iniciar Servidor Express ---
const port = process.env.PORT || 8080;
const host = '0.0.0.0';
const numericPort = Number(port);

if (isNaN(numericPort)) { console.error(`Porta inválida: ${port}.`); process.exit(1); }

const server = app.listen(numericPort, host, () => {
    console.info(`Servidor Express escutando em http://${host}:${numericPort}`); // Log http for Render detection
    console.info(`Webhook Telegram esperado em: ${WEBHOOK_PATH}`);
});

// --- Encerramento Gracioso ---
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
