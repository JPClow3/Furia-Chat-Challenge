"use strict";
/* eslint-disable */
// functions/src/index.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = exports.furiaChatFlow = exports.TeamPlayerType = void 0;
const dotenv = __importStar(require("dotenv"));
const functions = __importStar(require("firebase-functions"));
const logger = __importStar(require("firebase-functions/logger"));
const z = __importStar(require("zod"));
const genkit_1 = require("genkit");
const vertexai_1 = require("@genkit-ai/vertexai");
const hltv_1 = __importDefault(require("hltv"));
const wikipedia_1 = __importDefault(require("wikipedia"));
const path = __importStar(require("node:path"));
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
// Carrega variáveis do .env (principalmente para desenvolvimento local)
dotenv.config({ path: path.resolve(__dirname, '../../.env') }); // Ajuste se necessário
// --- Obtenha o Token do Telegram da variável de ambiente ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
if (!telegramToken) {
    logger.error("Erro Crítico: TELEGRAM_BOT_TOKEN não está definido nas variáveis de ambiente!");
    throw new Error("Token do Telegram não configurado.");
}
logger.info("Token do Telegram carregado com sucesso.");
const bot = new node_telegram_bot_api_1.default(telegramToken);
logger.info("Instância do Bot do Telegram criada.");
// Enumeração para tipos de jogador
var TeamPlayerType;
(function (TeamPlayerType) {
    TeamPlayerType["Coach"] = "Coach";
    TeamPlayerType["Starter"] = "Starter";
    TeamPlayerType["Substitute"] = "Substitute";
    TeamPlayerType["Benched"] = "Benched";
})(TeamPlayerType || (exports.TeamPlayerType = TeamPlayerType = {}));
// --- Configuração do Genkit e Vertex AI ---
logger.info("Iniciando configuração do Genkit com Vertex AI...");
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION;
if (!GCLOUD_PROJECT || !GCLOUD_LOCATION) {
    logger.error("AVISO: Variáveis GOOGLE_CLOUD_PROJECT ou GOOGLE_CLOUD_LOCATION não definidas.");
    throw new Error("Configuração do Genkit falhou: GOOGLE_CLOUD_PROJECT ou GOOGLE_CLOUD_LOCATION não configurados.");
}
else {
    logger.info(`Genkit - GOOGLE_CLOUD_PROJECT: ${GCLOUD_PROJECT}, LOCATION: ${GCLOUD_LOCATION}`);
}
const ai = (0, genkit_1.genkit)({
    plugins: [(0, vertexai_1.vertexAI)({ projectId: GCLOUD_PROJECT, location: GCLOUD_LOCATION })],
});
logger.info("Instância do Genkit AI criada com plugin Vertex AI.");
// --- Definição das Ferramentas (Tools) ---
// Tool: Elenco Atual da FURIA
const furiaRosterToolInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool({
    name: "getFuriaRoster",
    description: "Busca a escalação atual de jogadores do time de CS2 da FURIA Esports diretamente do HLTV.org. Use esta ferramenta sempre que for perguntado sobre os jogadores atuais ou o elenco.",
    inputSchema: furiaRosterToolInputSchema,
    outputSchema: z.object({
        players: z.array(z.object({
            name: z.string().describe("Nome do jogador"),
            type: z.nativeEnum(TeamPlayerType).describe("Posição do jogador (Starter, Substitute, etc.)")
        })).optional().describe("Lista de jogadores ativos e suas posições"),
        error: z.string().optional().describe("Mensagem de erro se a busca falhar"),
    }),
}, async (input) => {
    logger.info("[Tool:getFuriaRoster] Ferramenta chamada.");
    try {
        const team = await hltv_1.default.getTeam({ id: 8297 });
        if (!team) {
            logger.warn("[Tool:getFuriaRoster] Objeto 'team' não retornado pelo HLTV para ID 8297.");
            return { error: "Não foi possível obter dados da equipe FURIA no HLTV." };
        }
        const players = team.players
            ?.map(p => ({
            name: p.name || 'Nome Indisponível',
            type: Object.values(TeamPlayerType).includes(p.type) ? p.type : TeamPlayerType.Starter
        }))
            .filter(p => p.name !== 'Nome Indisponível') || [];
        if (players.length === 0) {
            logger.warn("[Tool:getFuriaRoster] Nenhum jogador válido encontrado para a FURIA.");
            return { error: "Não foram encontrados jogadores válidos para a FURIA no HLTV no momento." };
        }
        logger.info(`[Tool:getFuriaRoster] Jogadores encontrados: ${players.map(p => p.name).join(', ')}`);
        return { players: players };
    }
    catch (err) {
        logger.error("[Tool:getFuriaRoster] Erro ao buscar dados no HLTV:", err);
        const message = err instanceof Error ? err.message : "Erro desconhecido ao buscar no HLTV";
        return { error: `Ocorreu um erro ao tentar buscar os dados no HLTV: ${message}` };
    }
});
// Tool: Pesquisa na Wikipedia
const wikipediaInputSchema = z.object({ searchTerm: z.string().describe("Termo a ser pesquisado na Wikipedia") });
const searchWikipediaTool = ai.defineTool({
    name: "searchWikipedia",
    description: "Busca um resumo sobre um tópico específico na Wikipedia em Português.",
    inputSchema: wikipediaInputSchema,
    outputSchema: z.object({
        summary: z.string().optional().describe("Resumo do artigo encontrado"),
        url: z.string().url().optional().describe("URL completa do artigo na Wikipedia"),
        error: z.string().optional().describe("Mensagem de erro se a busca falhar")
    }),
}, async (input) => {
    const { searchTerm } = input;
    logger.info(`[Tool:searchWikipedia] Buscando '${searchTerm}'.`);
    try {
        await wikipedia_1.default.setLang('pt');
        const page = await wikipedia_1.default.page(searchTerm);
        if (!page) {
            logger.warn(`[Tool:searchWikipedia] Página '${searchTerm}' não encontrada.`);
            return { error: `Página '${searchTerm}' não encontrada.` };
        }
        const summary = await page.summary();
        logger.info(`[Tool:searchWikipedia] Resumo encontrado para '${searchTerm}'.`);
        return { summary: summary.extract, url: page.fullurl };
    }
    catch (err) {
        logger.error(`[Tool:searchWikipedia] Erro ao buscar na Wikipedia: ${err}`);
        const message = err instanceof Error ? err.message : "Erro desconhecido ao buscar na Wikipedia";
        return { error: `Erro na Wikipedia: ${message}` };
    }
});
logger.info("Ferramentas Genkit definidas: getFuriaRoster, searchWikipedia");
// --- Flow Principal do Chat ---
exports.furiaChatFlow = ai.defineFlow({
    name: "furiaChatFlow",
    inputSchema: z.string().describe("Mensagem do usuário"),
    outputSchema: z.string().describe("Resposta do assistente"),
}, async (userMessage) => {
    logger.info(`[Flow:furiaChatFlow] Mensagem Recebida: "${userMessage}"`);
    const systemInstruction = `Você é um assistente especialista focado exclusivamente na equipe de CS2 da FURIA Esports. Responda apenas a perguntas sobre este time.
**IMPORTANTE: Se for perguntado sobre a escalação atual, jogadores ou elenco da FURIA CS2, SEMPRE use a ferramenta 'getFuriaRoster' para obter a informação mais recente do HLTV.org antes de responder.** Liste os jogadores claramente se a ferramenta retornar sucesso.
Se a ferramenta retornar um erro, informe ao usuário que não foi possível buscar os dados atualizados no momento.
Para perguntas gerais sobre a história da FURIA, jogadores específicos (como Fallen, KSCERATO) ou conceitos de CS, você pode usar seu conhecimento ou a ferramenta 'searchWikipedia'.
Se a pergunta for sobre próximos jogos ou resultados recentes, informe que essa funcionalidade ainda não está implementada.
Se a pergunta for sobre qualquer outro assunto não relacionado à FURIA ou CS (outro time, outro jogo, F1, etc.), recuse educadamente informando sua especialidade exclusiva na FURIA CS2.`;
    try {
        const resp = await ai.generate({
            model: 'gemini-2.0-flash',
            messages: [
                { role: 'system', content: [{ text: systemInstruction }] },
                { role: 'user', content: [{ text: userMessage }] }
            ],
            tools: [getFuriaRosterTool, searchWikipediaTool],
            config: {
                temperature: 0.3
            }
        });
        const botReply = resp.text ?? 'Não consegui formular uma resposta no momento.';
        logger.info(`[Flow:furiaChatFlow] Resposta gerada: "${botReply.substring(0, 100)}..."`);
        return botReply;
    }
    catch (err) {
        logger.error("[Flow:furiaChatFlow] Erro Crítico durante a geração:", err);
        const errorMessage = err instanceof Error ? err.message : "Erro desconhecido no fluxo";
        return `Desculpe, ocorreu um erro interno ao processar sua solicitação. Detalhe: ${errorMessage}`;
    }
});
logger.info("Flow Genkit 'furiaChatFlow' definido.");
// --- Função HTTP Principal (Webhook do Telegram) ---
exports.api = functions.https.onRequest(async (request, response) => {
    // TODO: Adicionar verificação do secret_token em produção
    if (request.method === "POST") {
        const update = request.body;
        logger.debug("Webhook Telegram Recebido:", JSON.stringify(update, null, 2));
        if (update.message?.text && update.message.chat) {
            const chatId = update.message.chat.id;
            const userMessage = update.message.text;
            const userId = update.message.from?.id;
            if (update.message.from?.is_bot) {
                logger.info(`[Webhook] Mensagem do bot ${update.message.from.username} (ID: ${userId}) ignorada.`);
                response.status(200).send("OK (Bot Message Ignored)");
                return;
            }
            logger.info(`[Webhook] Mensagem recebida no chat ${chatId} (User: ${userId}): "${userMessage}"`);
            try {
                try {
                    await bot.sendChatAction(chatId, "typing");
                }
                catch (actionError) {
                    logger.warn(`[Webhook] Falha ao enviar 'typing' para chat ${chatId}:`, actionError);
                }
                const flowResult = await exports.furiaChatFlow.run(userMessage);
                // CORREÇÃO APLICADA: Usar replyText no log
                let replyText;
                if (typeof flowResult === 'string') {
                    replyText = flowResult;
                }
                else {
                    // Este else pode não ser estritamente necessário se o flow SEMPRE retorna string,
                    // mas é uma segurança caso algo mude no Genkit ou no seu flow.
                    logger.error(`[Webhook] Resultado inesperado do flow (não é string): ${typeof flowResult}`, flowResult);
                    replyText = "Desculpe, ocorreu um erro interno ao gerar a resposta.";
                }
                // Log usando a variável corrigida 'replyText'
                logger.info(`[Webhook] Resposta gerada (pronta para envio): "${replyText.substring(0, 100)}..."`); // Log truncado
                await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
                logger.info(`[Webhook] Resposta enviada para ${chatId}.`);
                response.status(200).send("OK (Message Processed)");
            }
            catch (error) {
                logger.error(`[Webhook] Erro CRÍTICO ao processar mensagem para chat ${chatId}:`, error);
                try {
                    await bot.sendMessage(chatId, "🤖 Desculpe, encontrei um problema técnico inesperado. Por favor, tente novamente mais tarde.");
                }
                catch (sendError) {
                    logger.error("[Webhook] Falha ao enviar mensagem de erro de volta ao Telegram:", sendError);
                }
                // Mantém 200 OK para o Telegram não reenviar, mas o erro foi logado.
                response.status(200).send("OK (Error Processed Internally)");
            }
            // CORREÇÃO APLICADA: Este 'else' foi removido daqui pois estava incorreto e causava erros.
            // A lógica para ignorar updates já está abaixo.
        }
        else {
            // Trata outros tipos de updates ou mensagens sem texto/chat válidos
            logger.info(`[Webhook] Update ignorado (sem texto ou chat válido): ${JSON.stringify(update)}`);
            response.status(200).send("OK (Update Ignored/Not Applicable)");
        }
    }
    else {
        // Rejeita métodos diferentes de POST
        logger.warn(`[Webhook] Método ${request.method} não permitido.`);
        response.setHeader("Allow", "POST");
        response.status(405).send("Method Not Allowed");
    }
});
// --- Lembrete Final: Configuração do Webhook ---
// Após o deploy (`firebase deploy --only functions`), pegue a URL da função `api`.
// Configure o webhook no Telegram usando seu NOVO TOKEN:
// https://api.telegram.org/bot<SEU_NOVO_TOKEN>/setWebhook?url=<URL_DA_FUNCAO_API>
// Opcional: Adicione `&secret_token=<SEU_TOKEN_SECRETO>` para segurança.
logger.info("Função 'api' inicializada e pronta para receber webhooks do Telegram.");
//# sourceMappingURL=index.js.map