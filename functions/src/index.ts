/* eslint-disable */
// index.ts (Agora na raiz do código que irá para o Railway, ex: dentro da pasta 'functions')

import * as dotenv from "dotenv";
import * as logger from "firebase-functions/logger"; // Pode manter ou trocar por outra lib de log (console, pino, etc.)
import * as z from "zod";
import {genkit} from "genkit";
import {vertexAI} from "@genkit-ai/vertexai";
import * as path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import express from "express"; // <--- ADICIONADO EXPRESS

// Carrega variáveis do .env (útil para desenvolvimento local)
// No Railway, você configurará as variáveis de ambiente na interface deles.
dotenv.config({ path: path.resolve(__dirname, '../.env') }); // Ajuste o path se a estrutura de pastas mudar

// --- Obtenha o Token do Telegram da variável de ambiente ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
if (!telegramToken) {
    logger.error("Erro Crítico: TELEGRAM_BOT_TOKEN não está definido!");
    // Em um servidor real, talvez não lançar erro, mas logar e não iniciar o bot
    throw new Error("Token do Telegram não configurado.");
}
logger.info("Token do Telegram carregado.");
// Não precisamos do modo polling, vamos usar webhook.
const bot = new TelegramBot(telegramToken);
logger.info("Instância do Bot do Telegram criada.");

// Enumeração para tipos de jogador
export enum TeamPlayerType { Coach="Coach", Starter="Starter", Substitute="Substitute", Benched="Benched" }

// --- Configuração do Genkit e Vertex AI ---
logger.info("Iniciando configuração do Genkit com Vertex AI...");
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT!;
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION!;
// IMPORTANTE: GOOGLE_APPLICATION_CREDENTIALS será necessário no Railway (veja passo 4)

if (!GCLOUD_PROJECT || !GCLOUD_LOCATION) {
    logger.error("AVISO: Variáveis GOOGLE_CLOUD_PROJECT ou GOOGLE_CLOUD_LOCATION não definidas.");
    throw new Error("Variáveis de ambiente do GCP não configuradas.");
} else {
    logger.info(`Genkit - GOOGLE_CLOUD_PROJECT: ${GCLOUD_PROJECT}, LOCATION: ${GCLOUD_LOCATION}`);
}

const ai = genkit({
    plugins: [vertexAI({ projectId: GCLOUD_PROJECT, location: GCLOUD_LOCATION })],
});
logger.info("Instância do Genkit AI criada.");

// --- Definição das Ferramentas (Tools) ---
// (Mantenha as definições das ferramentas getFuriaRosterTool e searchWikipediaTool exatamente como estavam antes)
// Tool: Elenco Atual da FURIA
const furiaRosterToolInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool({
    name: "",
    description: "",
}, async (input) => { /* ... Lógica completa ... */ });
// Tool: Pesquisa na Wikipedia
const wikipediaInputSchema = z.object({ searchTerm: z.string().describe("Termo a ser pesquisado na Wikipedia") });
const searchWikipediaTool = ai.defineTool({
    name: "",
    description: "",
}, async (input) => { /* ... Lógica completa ... */ });
logger.info("Ferramentas Genkit definidas.");

// --- Flow Principal do Chat ---
// (Mantenha a definição do furiaChatFlow exatamente como estava antes)
// @ts-ignore
export const furiaChatFlow = ai.defineFlow({ /* ... Definição completa ... */ }, async (userMessage) => { /* ... Lógica completa ... */ });
logger.info("Flow Genkit 'furiaChatFlow' definido.");

// --- Configuração do Servidor Express ---
const app = express();
// Middleware para parsear JSON do webhook do Telegram
app.use(express.json());

// Rota de verificação simples (opcional)
app.get('/', (req, res) => {
    res.send('Bot Furia CS está rodando!');
});

// --- Rota do Webhook do Telegram ---
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`; // Adiciona token na URL para segurança básica
app.post(WEBHOOK_PATH, async (req, res) => {
    const update: TelegramBot.Update = req.body;
    logger.debug("Webhook Telegram Recebido (Express):", JSON.stringify(update, null, 2));

    if (update.message?.text && update.message.chat) {
        const chatId = update.message.chat.id;
        const userMessage = update.message.text;
        const userId = update.message.from?.id;

        if (update.message.from?.is_bot) {
            logger.info(`[Webhook] Mensagem do bot ${update.message.from.username} ignorada.`);
            return res.sendStatus(200); // Responde OK rapidamente
        }

        logger.info(`[Webhook] Mensagem recebida no chat ${chatId} (User: ${userId}): "${userMessage}"`);

        // Responde OK imediatamente para o Telegram (evita timeout)
        res.sendStatus(200);

        // Processamento Assíncrono (sem await aqui para liberar a resposta HTTP)
        processTelegramUpdate(chatId, userMessage).catch(error => {
            logger.error(`[Webhook] Erro não tratado no processamento assíncrono para chat ${chatId}:`, error);
            // Tentar notificar usuário sobre erro geral (último recurso)
            bot.sendMessage(chatId, "⚠️ Ocorreu um erro inesperado ao processar sua solicitação.").catch(e => logger.error("Falha ao enviar msg de erro final", e));
        });

    } else {
        logger.info(`[Webhook] Update ignorado (sem texto ou chat válido).`);
        return res.sendStatus(200); // Responde OK para outros tipos de update
    }
});

// Função separada para processamento assíncrono
async function processTelegramUpdate(chatId: number, userMessage: string): Promise<void> {
    try {
        await bot.sendChatAction(chatId, "typing");
        const flowResult = await furiaChatFlow.run(userMessage);

        let replyText: string;
        if (typeof flowResult === 'string') {
            replyText = flowResult;
        } else {
            logger.error(`[Process] Resultado inesperado do flow: ${typeof flowResult}`, flowResult);
            replyText = "Desculpe, ocorreu um erro interno ao gerar a resposta.";
        }
        logger.info(`[Process] Resposta gerada (pronta para envio): "${replyText.substring(0, 100)}..."`);

        await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
        logger.info(`[Process] Resposta enviada para ${chatId}.`);

    } catch (error) {
        logger.error(`[Process] Erro CRÍTICO ao processar mensagem para chat ${chatId}:`, error);
        try {
            await bot.sendMessage(chatId, "🤖 Desculpe, encontrei um problema técnico inesperado. Por favor, tente novamente mais tarde.");
        } catch (sendError) {
            logger.error("[Process] Falha ao enviar mensagem de erro de volta ao Telegram:", sendError);
        }
    }
}


// --- Iniciar o Servidor ---
const port = process.env.PORT || 8080; // Porta definida pelo Railway ou padrão 8080
app.listen(port, () => {
    logger.info(`Servidor Express escutando na porta ${port}`);
    logger.info(`Webhook do Telegram esperado em: /telegram/webhook/${telegramToken}`);
    // Lembre-se de configurar o webhook no Telegram após o deploy!
});
