/* eslint-disable */
// index.ts
// Código completo com CORREÇÃO do erro de importação TS2305.

import * as dotenv from "dotenv";
import express from "express";
import type {ZodIssue} from "zod";
import * as z from "zod";

// --- Imports Genkit ---
import {genkit, GenkitError, MessageData} from "genkit";
import {gemini15Flash, googleAI} from "@genkit-ai/googleai";
// CORREÇÃO TS2305: Remover GenerateResponse da importação abaixo
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
    playersInfo: z.string().optional().describe("String formatada com nome e tipo dos jogadores (ou apenas nomes se tipo não disponível)."),
    error: z.string().optional().describe("Mensagem de erro se a busca falhar em todas as fontes."),
    source: z.enum(['HLTV', 'Liquipedia']).optional().describe("Fonte da informação (HLTV ou Liquipedia)."),
});

// Função de execução com fallback para Liquipedia MediaWiki API e seletores CORRIGIDOS
async function executeGetFuriaRoster(): Promise<z.infer<typeof furiaRosterOutputSchema>> {
    console.info("[Tool Exec] getFuriaRoster chamada (HLTV com fallback Liquipedia API).");
    const hltvCacheKey = "hltv:furia_roster_v2";
    const liquipediaCacheKey = "liquipedia:furia_roster_v2";
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
            const team = await HLTV.getTeam({ id: 8297 });
            if (!team?.players?.length) throw new Error("Dados/jogadores não encontrados no HLTV.");
            const players = team.players
              .map(p => ({ name: p.name || 'N/A', type: Object.values(TeamPlayerType).includes(p.type as TeamPlayerType) ? p.type as TeamPlayerType : TeamPlayerType.Starter }))
              .filter(p => p.name !== 'N/A');
            if (players.length === 0) throw new Error("Nenhum jogador válido encontrado no HLTV.");
            const playersInfo = players.map(p => `${p.name} (${p.type})`).join(', ');
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
            // Don't return immediately if it's a Cloudflare block, proceed to Liquipedia
            // Only return here if it was a different HLTV error
            if (!isCloudflareBlock) {
                // We don't return the error details here, just indicate fallback will happen
                // The final error will be composed later if Liquipedia also fails.
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
                const parsedCache = rosterCacheSchema.parse(JSON.parse(cachedData));
                if (parsedCache && !parsedCache.error) {
                    console.info(`[Cache Liquipedia] hit ${liquipediaCacheKey}`);
                    return { playersInfo: parsedCache.playersInfo, source: 'Liquipedia' };
                } else if (parsedCache?.error) {
                    console.warn(`[Cache Liquipedia] hit com erro ${liquipediaCacheKey}: ${parsedCache.error}. Tentando buscar novamente.`);
                    // Don't use the cached error, try fetching again.
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
            timeout: 20000 // Increased timeout
        });

        if (response.data?.error) throw new Error(`API Liquipedia retornou erro: ${response.data.error.info}`);
        const htmlContent = response.data?.parse?.text?.['*'];
        if (!htmlContent) throw new Error("Conteúdo HTML não encontrado na resposta da API Liquipedia.");

        // --- LOGGING HTML PARA DEBUG (Remover ou comentar em produção) ---
        // console.log("--- DEBUG LIQUIPEDIA HTML ---");
        // console.log(htmlContent.substring(0, 2000)); // Logar início do HTML
        // console.log("--- END DEBUG LIQUIPEDIA HTML ---");
        // --- FIM LOGGING ---

        const $ = cheerio.load(htmlContent);
        const players: string[] = [];

        // --- SELETORES CHEERIO REFINADOS ---
        // 1. Encontrar o H2 que contém o ID "Player_Roster" (ou similar)
        let rosterHeader = $('h2:has(#Player_Roster)'); // Procura H2 com span id="Player_Roster" dentro
        if (rosterHeader.length === 0) {
            rosterHeader = $('h2').filter((_i, el) => $(el).text().trim().includes('Player Roster')); // Fallback por texto
            if (rosterHeader.length === 0) {
                console.warn("Não foi possível encontrar o header 'Player Roster', tentando H3 'Active'...");
                rosterHeader = $('h3:has(#Active)'); // Tenta H3 Active como último recurso
            }
        }

        if (rosterHeader.length === 0) {
            throw new Error("Não foi possível encontrar a seção de elenco (Player Roster / Active) na página.");
        }

        // 2. Encontrar a PRIMEIRA tabela 'wikitable roster-card' DEPOIS do header encontrado
        const rosterTable = rosterHeader.first().nextAll('div.roster-card-wrapper').first().find('table.wikitable.roster-card').first();
        // Se não achar dentro de wrapper, tenta diretamente a tabela seguinte
        // const rosterTable = rosterHeader.first().nextAll('table.wikitable.roster-card').first();

        if (rosterTable.length === 0) {
            // Tenta encontrar a primeira tabela roster-card na página como fallback extremo
            const fallbackTable = $('table.wikitable.roster-card').first();
            if (fallbackTable.length > 0) {
                console.warn("Não encontrou tabela após header, usando a primeira 'roster-card' encontrada na página.");
                // rosterTable = fallbackTable; // Descomentar se quiser usar este fallback
                throw new Error("Não foi possível encontrar a tabela de elenco ativa após o header."); // Mais seguro falhar
            } else {
                throw new Error("Não foi possível encontrar nenhuma tabela 'wikitable roster-card' na página.");
            }
        }

        // 3. Extrair jogadores da tabela encontrada
        console.info("Tabela de elenco encontrada, processando linhas...");
        rosterTable.find('tbody tr.Player').each((_rowIndex, row) => {
            // Pega o link dentro da primeira célula 'td' com classe 'ID'
            const playerLink = $(row).find('td.ID a').first();
            const playerName = playerLink.attr('title'); // Pega o nome do atributo title

            // Verifica se o nome foi encontrado e não é uma página inexistente
            if (playerName && !playerName.includes('(page does not exist)')) {
                players.push(playerName.trim());
            } else {
                // Fallback para o texto do link se o title falhar (menos ideal)
                const fallbackName = playerLink.text().trim();
                if (fallbackName) {
                    console.warn(`[Liquipedia Parser] Usando fallback de texto para jogador: ${fallbackName}`);
                    players.push(fallbackName);
                } else {
                    console.warn("[Liquipedia Parser] Não foi possível extrair nome do jogador da linha:", $(row).html());
                }
            }
        });
        // --- FIM DOS SELETORES ---

        if (players.length > 0) {
            const playersInfo = players.join(', ');
            console.info("[Liquipedia API] Sucesso:", playersInfo);
            liquipediaResult = { playersInfo: playersInfo, source: 'liquipedia' };
        } else {
            console.error("[Liquipedia API] Extração de jogadores da tabela resultou em lista vazia. Verifique os seletores e a estrutura HTML retornada pela API.");
            // Logar HTML aqui pode ser útil
            // console.log("HTML da tabela:", rosterTable.html());
            throw new Error("Extração da tabela de elenco ativa não retornou jogadores (verificar seletores/estrutura API).");
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
        // Compõe a mensagem de erro final com base nos erros de HLTV e Liquipedia
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
      description: "Busca a escalação ATUAL de jogadores da FURIA CS2. Tenta HLTV.org primeiro, e usa a API da Liquipedia como fallback se HLTV estiver inacessível ou falhar.",
      inputSchema: z.object({}), // Não precisa de input
      outputSchema: furiaRosterOutputSchema,
  },
  executeGetFuriaRoster
);

// --- Wikipedia Tool ---
const wikipediaSearchSchema = z.object({ searchTerm: z.string().describe("Termo a pesquisar") });
const wikipediaOutputSchema = z.object({
    summary: z.string().optional().describe("Resumo do artigo."),
    error: z.string().optional(),
    source: z.literal('cache').or(z.literal('api')).optional(),
});
async function executeSearchWikipedia(input: z.infer<typeof wikipediaSearchSchema>): Promise<z.infer<typeof wikipediaOutputSchema>> {
    const searchTerm = input.searchTerm;
    console.info(`[Tool Exec] searchWikipedia buscando '${searchTerm}'.`);
    const cacheKey = `wiki:${searchTerm.toLowerCase().replace(/\s+/g, '_')}`; // Normaliza chave
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
                        // Se for erro cacheado, não retorna, tenta buscar novamente
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
        wiki.setLang('pt'); // Garante português
        const page = await wiki.page(searchTerm, { autoSuggest: true }); // Tenta achar a página
        let apiResult: z.infer<typeof wikipediaOutputSchema>;

        if (!page) {
            console.warn(`[Wiki API] Página '${searchTerm}' não encontrada.`);
            apiResult = { error: `Página '${searchTerm}' não encontrada na Wikipedia.` };
        } else {
            const summaryResult = await page.summary(); // Pega o resumo
            if (!summaryResult?.extract) {
                console.warn(`[Wiki API] Resumo vazio para ${searchTerm}.`);
                apiResult = { error: `Não foi possível obter um resumo para '${searchTerm}'.` };
            } else {
                // Limita o tamanho do resumo para evitar exceder limites
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

        // Cacheia o resultado (sucesso ou erro da API)
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

        // Cacheia o erro da API
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
      description: "Busca um resumo sobre um tópico na Wikipedia em Português. Útil para obter informações sobre jogadores, times, eventos, etc.",
      inputSchema: wikipediaSearchSchema,
      outputSchema: wikipediaOutputSchema,
  },
  executeSearchWikipedia
);

console.info("Ferramentas Genkit definidas: getFuriaRoster (com fallback API), searchWikipedia");


// --- Definição do Flow Principal do Chat ---
const flowInputSchema = z.object({
    userMessage: z.string(),
    chatHistory: z.array(z.any()).optional().default([]), // Recebe histórico como array genérico
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

      // Converte/Valida histórico recebido para MessageData[]
      const validHistory: MessageData[] = chatHistory
        .map((msg: any) => {
            // Validação básica da estrutura esperada
            if (msg && typeof msg.role === 'string' && Array.isArray(msg.content)) {
                // Valida conteúdo (simplificado, pode ser mais robusto)
                const validContent = msg.content.every((part: any) =>
                  typeof part.text === 'string' || part.toolRequest || part.toolResponse
                );
                if (validContent) {
                    return msg as MessageData;
                }
            }
            console.warn("[Flow] Mensagem inválida no histórico recebido:", msg);
            return null; // Descarta mensagens inválidas
        })
        .filter((msg): msg is MessageData => msg !== null); // Remove nulos


      const currentHistory: MessageData[] = [...validHistory];
      currentHistory.push({ role: 'user', content: [{ text: userMessage }] });

      // Limita o histórico ANTES de enviar para a IA (contando pares user/model + tool)
      const MAX_FLOW_HISTORY_MESSAGES = 8; // Máximo de 8 mensagens (4 pares user/model + tools)
      while (currentHistory.length > MAX_FLOW_HISTORY_MESSAGES) {
          currentHistory.shift(); // Remove a mais antiga
      }
      console.info(`[Flow] Histórico antes da IA (após adição/trim): ${currentHistory.length} msgs`);

      const systemInstruction = `Você é um assistente especialista focado exclusivamente na equipe de CS2 da FURIA Esports. Use as ferramentas disponíveis para buscar informações ATUALIZADAS quando necessário (escalação 'getFuriaRoster', informações gerais 'searchWikipedia'). Responda APENAS sobre a FURIA CS2 ou seus jogadores e técnico. Seja conciso e direto. Se não souber, a pergunta for sobre outro time/jogo, ou a ferramenta falhar em obter a informação, diga que não tem essa informação específica ou que houve um problema ao buscar. Sempre use português do Brasil. Nunca invente informações. Se a ferramenta 'getFuriaRoster' retornar um erro, informe o usuário que não foi possível buscar a escalação no momento.`;

      const messagesForAI: MessageData[] = [
          { role: 'system', content: [{ text: systemInstruction }] },
          ...currentHistory // Adiciona o histórico já trimado
      ];

      // --- VALIDAÇÃO DE HISTÓRICO ---
      // Verifica se a primeira mensagem após o system prompt é 'user'
      // Isso previne o erro "[GoogleGenerativeAI Error]: First content should be with role 'user', got model"
      if (messagesForAI.length > 1 && messagesForAI[1].role !== 'user') {
          console.error(
            "CRITICAL ERROR [Flow]: History is invalid! First message after system prompt is not 'user'.",
            "Messages slice:", JSON.stringify(messagesForAI.slice(0, 3))
          );
          // Retorna uma mensagem de erro segura para o usuário e evita chamar a IA com histórico inválido
          return "Desculpe, houve um problema interno ao processar o histórico da conversa. Por favor, tente enviar sua mensagem novamente.";
      }
      // --- FIM DA VALIDAÇÃO ---


      try {
          console.info(`[Flow] Chamando ai.generate com ${messagesForAI.length} mensagens e ${[getFuriaRosterTool, searchWikipediaTool].length} ferramentas.`);

          // CORREÇÃO TS2305: Remover tipo GenerateResponse da declaração
          let llmResponse = await ai.generate({
              model: gemini15Flash,
              messages: messagesForAI,
              tools: [getFuriaRosterTool, searchWikipediaTool],
              config: { temperature: 0.6 }, // Levemente menos criativo
              // safetySettings: [...] // Considerar adicionar safety settings se necessário
          });

          let attempts = 0;
          const MAX_TOOL_ATTEMPTS = 3; // Limite mais razoável de tentativas de ferramenta

          // Loop para lidar com chamadas de ferramentas
          while (attempts < MAX_TOOL_ATTEMPTS) {
              const responseMessage = llmResponse.message; // A resposta da IA (pode ser texto ou pedido de ferramenta)

              // Verifica se a resposta é inválida
              if (!responseMessage || !Array.isArray(responseMessage.content)) {
                  // CORREÇÃO TS6234: Acessar .text como propriedade
                  const directText = llmResponse.text; // Tenta obter texto direto
                  if (directText) {
                      console.warn("[Flow] Usando llmResponse.text pois .message ou .content é inválido/ausente.");
                      return directText; // Retorna o texto direto se houver
                  }
                  console.error("[Flow] Resposta da IA inválida ou vazia:", llmResponse);
                  return "Desculpe, não consegui processar a resposta da IA neste momento.";
              }


              // Verifica se a IA pediu para usar uma ferramenta
              const toolRequestParts = responseMessage.content.filter(part => part.toolRequest);

              // Se não pediu ferramenta, a resposta é final
              if (toolRequestParts.length === 0) {
                  // CORREÇÃO TS6234: Acessar .text como propriedade
                  const finalText = llmResponse.text;
                  console.info(`[Flow] Resposta final IA (sem ferramenta): "${finalText?.substring(0, 100)}..."`);
                  return finalText ?? "Não consegui gerar uma resposta."; // Retorna o texto final
              }

              // Se pediu ferramenta, executa e envia de volta
              attempts++;
              // CORREÇÃO TS18048: Usar asserção não nula (!) pois o filtro garante que toolRequest existe
              console.info(`[Flow] Tentativa ${attempts}/${MAX_TOOL_ATTEMPTS}: ${toolRequestParts.length} ferramenta(s) solicitada(s): ${toolRequestParts.map(part => part.toolRequest!.name).join(', ')}`);

              // Adiciona a requisição da ferramenta ao histórico
              messagesForAI.push(responseMessage);

              const toolResponses: MessageData[] = []; // Armazena as respostas das ferramentas

              // Executa cada ferramenta solicitada
              for (const part of toolRequestParts) {
                  const toolRequest = part.toolRequest;
                  // Adicionado check extra para segurança, embora o filtro já faça isso
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

                  // Mapeia nome da ferramenta para a função e definição
                  if (toolName === getFuriaRosterTool.name) {
                      executor = executeGetFuriaRoster;
                      requiresInput = false; // getFuriaRoster não tem input
                      toolDefinition = getFuriaRosterTool;
                  } else if (toolName === searchWikipediaTool.name) {
                      executor = executeSearchWikipedia;
                      requiresInput = true; // searchWikipedia precisa de input
                      toolDefinition = searchWikipediaTool;
                  }

                  if (executor && toolDefinition) {
                      try {
                          if (requiresInput) {
                              // Valida o input fornecido pela IA usando o Zod schema da ferramenta
                              const validation = toolDefinition.inputSchema.safeParse(inputArgs);
                              if (!validation.success) {
                                  console.warn(`[Flow] Input inválido da IA para ${toolName}:`, inputArgs, validation.error.errors);
                                  output = { error: `Input inválido fornecido pela IA para ${toolName}: ${validation.error.errors.map((e: ZodIssue) => e.message).join(', ')}` };
                              } else {
                                  console.info(`[Flow] Input validado para ${toolName}. Executando...`);
                                  output = await executor(validation.data); // Chama a função da ferramenta com input validado
                              }
                          } else {
                              // Ferramenta sem input (getFuriaRoster)
                              output = await executor(); // Chama a função da ferramenta sem argumentos
                          }
                      } catch (executionError) {
                          console.error(`[Flow] Erro EXECUTANDO ferramenta ${toolName}:`, executionError);
                          output = { error: `Erro interno ao executar a ferramenta ${toolName}: ${executionError instanceof Error ? executionError.message : String(executionError)}` };
                      }
                  } else {
                      console.warn(`[Flow] Executor ou definição não encontrado para ferramenta: ${toolName}`);
                      output = { error: `Ferramenta '${toolName}' não reconhecida ou não implementada.` };
                  }

                  // Cria a mensagem de resposta da ferramenta
                  toolResponses.push({
                      role: 'tool',
                      content: [{ toolResponse: { name: toolName, output: output } }]
                  });
              } // Fim loop for tools

              // Adiciona as respostas das ferramentas ao histórico
              messagesForAI.push(...toolResponses);

              // Chama a IA novamente com o resultado das ferramentas
              console.info(`[Flow] Rechamando ai.generate com ${toolResponses.length} resposta(s) de ferramenta(s). Histórico total: ${messagesForAI.length} msgs.`);
              llmResponse = await ai.generate({
                  model: gemini15Flash,
                  messages: messagesForAI,
                  tools: [getFuriaRosterTool, searchWikipediaTool],
                  config: { temperature: 0.6 },
              });

          } // Fim loop while attempts

          // Se atingiu o limite de tentativas de ferramentas
          console.warn("[Flow] Limite de chamadas de ferramentas atingido.");
          // CORREÇÃO TS6234: Acessar .text como propriedade
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
          // Retorna uma mensagem de erro genérica e segura para o usuário
          return `Desculpe, ocorreu um problema interno inesperado ao processar sua solicitação (${errorDetails.substring(0,100)}...). Por favor, tente novamente mais tarde.`;
      }
  }
);
console.info("Flow Genkit 'furiaChatFlow' definido com lógica de ferramentas.");


// --- Configuração do Servidor Express ---
const app = express();
app.use(express.json()); // Middleware para parsear JSON no body

// Rota raiz simples para health check
app.get('/', (_req, res) => {
    res.status(200).send('Servidor Bot Furia CS (Render/Redis/Genkit+googleAI) Ativo!');
});

// --- Rota do Webhook Telegram ---
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`; // Caminho seguro usando o token
console.info(`Configurando POST para webhook em: ${WEBHOOK_PATH}`);

app.post(WEBHOOK_PATH, async (req, res) => {
    const update: TelegramBot.Update = req.body;

    // Validações básicas do update
    if (!update || !update.message || !update.message.text || !update.message.chat?.id) {
        console.info(`[Webhook] Update ignorado (estrutura inválida ou sem texto/ID).`);
        res.sendStatus(200); // Responde OK para o Telegram não reenviar
        return;
    }
    if (update.message.from?.is_bot) {
        console.info(`[Webhook] Update ignorado (mensagem de bot).`);
        res.sendStatus(200);
        return;
    }

    const chatId = update.message.chat.id;
    const userMessage = update.message.text.trim(); // Remove espaços extras
    console.info(`[Webhook] Msg chat ${chatId}: "${userMessage}"`);

    // Responde imediatamente ao Telegram para evitar timeouts
    res.sendStatus(200);

    const contextKey = `genkit_history:${chatId}`;
    let historyForFlow: MessageData[] = [];

    // --- Leitura do Histórico do Redis ---
    if (redis) {
        try {
            const storedHistory = await redis.get(contextKey);
            if (storedHistory) {
                try {
                    const parsedHistory = JSON.parse(storedHistory);
                    // Valida se é um array antes de usar
                    if (Array.isArray(parsedHistory)) {
                        // Filtra garantindo a estrutura mínima (pode ser mais robusto)
                        historyForFlow = parsedHistory.filter(msg =>
                          msg && typeof msg.role === 'string' && Array.isArray(msg.content)
                        );
                        console.info(`[Webhook] Histórico Genkit recuperado Redis chat ${chatId} (${historyForFlow.length} msgs válidas)`);
                    } else {
                        console.warn(`[Webhook] Histórico Genkit inválido (não é array) Redis chat ${chatId}. Ignorando.`);
                        await redis.del(contextKey); // Deleta histórico inválido
                    }
                } catch (parseError) {
                    console.warn(`[Webhook] Erro ao parsear histórico Genkit Redis chat ${chatId}. Ignorando.`, parseError);
                    await redis.del(contextKey); // Deleta histórico inválido
                }
            } else {
                console.info(`[Webhook] Histórico não encontrado no Redis para chat ${chatId}.`);
            }
        } catch (redisError) {
            console.error(`[Webhook] Erro leitura Redis chat ${chatId}:`, redisError);
            // Continua sem histórico em caso de erro no Redis
        }
    }

    // --- Execução do Flow e Resposta ---
    try {
        await bot.sendChatAction(chatId, "typing"); // Indica que o bot está "pensando"

        // Chama o flow Genkit de forma segura
        const flowResult = await runFlow(furiaChatFlow, {
            userMessage: userMessage,
            chatHistory: historyForFlow // Passa o histórico recuperado (ou vazio)
        });

        console.info(`[Webhook] Flow result raw: "${flowResult?.substring(0, 200)}..."`);

        const finalReply = flowResult;

        // --- Atualização e Salvamento do Histórico no Redis ---
        // Adiciona a mensagem do usuário e a resposta do modelo ao histórico que será salvo
        const lastUserMessage: MessageData = { role: 'user', content: [{ text: userMessage }] };
        const lastModelResponse: MessageData = { role: 'model', content: [{ text: finalReply }] };

        // Usa o histórico VÁLIDO recuperado como base para salvar
        const finalHistoryToSave = [...historyForFlow, lastUserMessage, lastModelResponse];

        // Limita o histórico que será salvo no Redis
        const MAX_REDIS_HISTORY_MESSAGES = 8; // Manter sincronizado com MAX_FLOW_HISTORY_MESSAGES
        while (finalHistoryToSave.length > MAX_REDIS_HISTORY_MESSAGES) {
            finalHistoryToSave.shift(); // Remove a mensagem mais antiga (seja user ou model)
        }

        if (redis) {
            try {
                // Salva por 30 minutos (ajustar conforme necessidade)
                await redis.set(contextKey, JSON.stringify(finalHistoryToSave), 'EX', 60 * 30);
                console.info(`[Webhook] Histórico Genkit (${finalHistoryToSave.length} msgs) salvo no Redis para chat ${chatId}`);
            } catch (redisError) {
                console.error(`[Webhook] Erro ao salvar histórico no Redis chat ${chatId}:`, redisError);
            }
        }

        // Envia a resposta final para o usuário no Telegram
        // Usar try-catch específico para o envio da mensagem
        try {
            await bot.sendMessage(chatId, finalReply, { parse_mode: 'Markdown' });
            console.info(`[Webhook] Resposta enviada para chat ${chatId}.`);
        } catch (telegramSendError) {
            console.error(`[Webhook] Erro ao ENVIAR mensagem via Telegram para chat ${chatId}:`, telegramSendError);
            // Não tentar reenviar mensagem de erro aqui para evitar loops
        }


    } catch (flowError) {
        // Captura erros que podem ocorrer na chamada do runFlow ou antes do envio da mensagem
        console.error(`[Webhook] Erro GERAL ao processar mensagem ou chamar flow para chat ${chatId}:`, flowError);
        try {
            // Tenta enviar uma mensagem de erro genérica ao usuário
            await bot.sendMessage(chatId, "⚠️ Desculpe, ocorreu um erro inesperado ao processar sua mensagem. Por favor, tente novamente.");
        } catch (sendErrorError) {
            // Se até o envio da mensagem de erro falhar, apenas loga
            console.error("[Webhook] Falha CRÍTICA ao enviar mensagem de erro final para o chat", chatId, sendErrorError);
        }
    }
});


// --- Iniciar Servidor Express ---
const port = process.env.PORT || 10000; // Porta padrão do Render
const host = '0.0.0.0'; // Necessário para o Render
const numericPort = Number(port);

if (isNaN(numericPort)) {
    console.error(`Porta inválida configurada: ${port}. Saindo.`);
    process.exit(1);
}

const server = app.listen(numericPort, host, () => {
    console.info(`Servidor Express escutando em https://${host}:${numericPort}`); // Usar http para Render internamente
    console.info(`Webhook Telegram configurado para POST em: ${WEBHOOK_PATH}`);
});

// --- Encerramento Gracioso (Graceful Shutdown) ---
const gracefulShutdown = (signal: string) => {
    console.info(`${signal} signal received: closing server...`);
    server.close(async () => { // Fecha o servidor HTTP
        console.info('HTTP server closed.');
        if (redis) {
            try {
                await redis.quit(); // Tenta fechar a conexão Redis
                console.info('Redis connection closed gracefully.');
            } catch (redisErr) {
                console.error('Erro ao fechar conexão Redis:', redisErr);
                process.exitCode = 1; // Indica erro na saída
            }
        }
        console.info('Exiting process.');
        process.exit(); // Sai do processo (process.exitCode será 0 ou 1)
    });

    // Define um timeout para forçar o encerramento se demorar muito
    setTimeout(() => {
        console.error("Could not close connections in time, forcefully shutting down");
        process.exit(1);
    }, 10000); // 10 segundos de timeout
};

// Escuta por sinais de encerramento
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Sinal padrão do Render/Docker
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Sinal de Ctrl+C
