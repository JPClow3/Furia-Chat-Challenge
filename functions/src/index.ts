/* eslint-disable */
// index.ts
// Adaptado para rodar como servidor Express no Railway, recebendo webhooks do Telegram
// e usando Genkit com Vertex AI.

import * as dotenv from "dotenv";
import * as logger from "firebase-functions/logger"; // Usando o logger do Firebase, pode trocar se preferir
import * as z from "zod";
import {genkit} from "genkit";
import {vertexAI} from "@genkit-ai/vertexai";
import HLTV from "hltv";
import wiki, {Page} from "wikipedia";
import * as path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import express from "express"; // Importa o Express

// Carrega variáveis do .env (útil para desenvolvimento local)
// No Railway, configure as variáveis de ambiente na interface deles.
// O path pode precisar de ajuste dependendo da estrutura final no repo/build.
dotenv.config({ path: path.resolve(__dirname, '../.env') }); // Se .env estiver um nível acima de 'lib'

// --- Obtenha o Token do Telegram da variável de ambiente ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
if (!telegramToken) {
    logger.error("Erro Crítico: TELEGRAM_BOT_TOKEN não está definido nas variáveis de ambiente!");
    // Em um servidor real, para evitar crash, logue e talvez não inicie o bot
    // ou lance o erro para impedir o start se o token for essencial.
    throw new Error("Token do Telegram não configurado.");
}
logger.info("Token do Telegram carregado com sucesso.");
// Instancia o bot. Não usamos 'polling' com webhooks.
const bot = new TelegramBot(telegramToken);
logger.info("Instância do Bot do Telegram criada.");

// Enumeração para tipos de jogador
export enum TeamPlayerType {
    Coach = "Coach",
    Starter = "Starter",
    Substitute = "Substitute",
    Benched = "Benched",
}

// --- Configuração do Genkit e Vertex AI ---
logger.info("Iniciando configuração do Genkit com Vertex AI...");
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT!;
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION!;
// Lembrete: GOOGLE_APPLICATION_CREDENTIALS precisa estar configurado no Railway!

if (!GCLOUD_PROJECT || !GCLOUD_LOCATION) {
    logger.error("Erro Crítico: Variáveis GOOGLE_CLOUD_PROJECT ou GOOGLE_CLOUD_LOCATION não definidas.");
    throw new Error("Configuração do Genkit falhou: Variáveis de ambiente GCP ausentes.");
} else {
    logger.info(`Genkit - GOOGLE_CLOUD_PROJECT: ${GCLOUD_PROJECT}, LOCATION: ${GCLOUD_LOCATION}`);
}

const ai = genkit({
    plugins: [vertexAI({ projectId: GCLOUD_PROJECT, location: GCLOUD_LOCATION })],
});
logger.info("Instância do Genkit AI criada com plugin Vertex AI.");

// --- Definição das Ferramentas (Tools) ---

// Tool: Elenco Atual da FURIA
const furiaRosterToolInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool(
  {
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
  },
  async (input: z.infer<typeof furiaRosterToolInputSchema>) => {
      logger.info("[Tool:getFuriaRoster] Ferramenta chamada.");
      try {
          const team = await HLTV.getTeam({ id: 8297 }); // ID da FURIA
          if (!team) {
              logger.warn("[Tool:getFuriaRoster] Objeto 'team' não retornado pelo HLTV para ID 8297.");
              return { error: "Não foi possível obter dados da equipe FURIA no HLTV." };
          }
          const players = team.players
            ?.map(p => ({
                name: p.name || 'Nome Indisponível',
                type: Object.values(TeamPlayerType).includes(p.type as TeamPlayerType) ? p.type as TeamPlayerType : TeamPlayerType.Starter
            }))
            .filter(p => p.name !== 'Nome Indisponível') || [];

          if (players.length === 0) {
              logger.warn("[Tool:getFuriaRoster] Nenhum jogador válido encontrado para a FURIA.");
              return { error: "Não foram encontrados jogadores válidos para a FURIA no HLTV no momento." };
          }
          logger.info(`[Tool:getFuriaRoster] Jogadores encontrados: ${players.map(p => p.name).join(', ')}`);
          return { players: players };
      } catch (err) {
          logger.error("[Tool:getFuriaRoster] Erro ao buscar dados no HLTV:", err);
          const message = err instanceof Error ? err.message : "Erro desconhecido ao buscar no HLTV";
          return { error: `Ocorreu um erro ao tentar buscar os dados no HLTV: ${message}` };
      }
  }
);

// Tool: Pesquisa na Wikipedia
const wikipediaInputSchema = z.object({ searchTerm: z.string().describe("Termo a ser pesquisado na Wikipedia") });
const searchWikipediaTool = ai.defineTool(
  {
      name: "searchWikipedia",
      description: "Busca um resumo sobre um tópico específico na Wikipedia em Português.",
      inputSchema: wikipediaInputSchema,
      outputSchema: z.object({
          summary: z.string().optional().describe("Resumo do artigo encontrado"),
          url: z.string().url().optional().describe("URL completa do artigo na Wikipedia"),
          error: z.string().optional().describe("Mensagem de erro se a busca falhar")
      }),
  },
  async (input: z.infer<typeof wikipediaInputSchema>) => {
      const { searchTerm } = input;
      logger.info(`[Tool:searchWikipedia] Buscando '${searchTerm}'.`);
      try {
          await wiki.setLang('pt');
          const page: Page | null = await wiki.page(searchTerm);
          if (!page) {
              logger.warn(`[Tool:searchWikipedia] Página '${searchTerm}' não encontrada.`);
              return { error: `Página '${searchTerm}' não encontrada.` };
          }
          const summary = await page.summary();
          logger.info(`[Tool:searchWikipedia] Resumo encontrado para '${searchTerm}'.`);
          return { summary: summary.extract, url: page.fullurl };
      } catch (err) {
          logger.error(`[Tool:searchWikipedia] Erro ao buscar na Wikipedia: ${err}`);
          const message = err instanceof Error ? err.message : "Erro desconhecido ao buscar na Wikipedia";
          return { error: `Erro na Wikipedia: ${message}` };
      }
  }
);
logger.info("Ferramentas Genkit definidas: getFuriaRoster, searchWikipedia");

// --- Flow Principal do Chat ---
export const furiaChatFlow = ai.defineFlow(
  {
      name: "furiaChatFlow",
      inputSchema: z.string().describe("Mensagem do usuário"),
      outputSchema: z.string().describe("Resposta do assistente"),
  },
  async (userMessage: string) => {
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
      } catch (err) {
          logger.error("[Flow:furiaChatFlow] Erro Crítico durante a geração:", err);
          const errorMessage = err instanceof Error ? err.message : "Erro desconhecido no fluxo";
          return `Desculpe, ocorreu um erro interno ao processar sua solicitação. Detalhe: ${errorMessage}`;
      }
  }
);
logger.info("Flow Genkit 'furiaChatFlow' definido.");


// --- Configuração do Servidor Express ---
const app = express();
// Middleware para parsear JSON do webhook do Telegram
app.use(express.json());

// Rota de verificação simples (opcional, para teste)
app.get('/', (req, res) => {
    res.status(200).send('Servidor do Bot Furia CS está ativo!');
});

// --- Rota do Webhook do Telegram ---
// Usamos o token na URL como uma forma simples de "segurança" para garantir que só o Telegram chame.
// Em produção real, considere usar o `secret_token` do Telegram.
const WEBHOOK_PATH = `/telegram/webhook/${telegramToken}`;
logger.info(`Configurando rota POST para o webhook em: ${WEBHOOK_PATH}`);

app.post(WEBHOOK_PATH, async (req, res) => {
    const update: TelegramBot.Update = req.body;
    // Usar logger.debug para logs muito verbosos, se necessário
    // logger.debug("Webhook Telegram Recebido (Express):", JSON.stringify(update, null, 2));

    if (update.message?.text && update.message.chat) {
        const chatId = update.message.chat.id;
        const userMessage = update.message.text;
        const userId = update.message.from?.id;

        // Ignora mensagens vindas de outros bots
        if (update.message.from?.is_bot) {
            logger.info(`[Webhook] Mensagem do bot ${update.message.from.username} (ID: ${userId}) ignorada.`);
            return res.sendStatus(200); // Responde OK para o Telegram
        }

        logger.info(`[Webhook] Mensagem recebida no chat ${chatId} (User: ${userId}): "${userMessage}"`);

        // Responde OK imediatamente para o Telegram (boa prática para webhooks)
        res.sendStatus(200);

        // Processa a mensagem em segundo plano (não bloqueia a resposta ao Telegram)
        processTelegramUpdate(chatId, userMessage).catch(error => {
            logger.error(`[Webhook] Erro não tratado no processamento assíncrono para chat ${chatId}:`, error);
            // Tenta notificar o usuário sobre erro geral (melhor esforço)
            bot.sendMessage(chatId, "⚠️ Ocorreu um erro inesperado. A equipe já foi notificada.").catch(e => logger.error("Falha ao enviar msg de erro final", e));
        });

    } else {
        // Ignora updates que não são mensagens de texto novas
        logger.info(`[Webhook] Update ignorado (sem texto ou chat válido): Tipo ${update.edited_message ? 'edited_message' : 'outro'}`);
        return res.sendStatus(200); // Responde OK para o Telegram
    }
});

// Função separada para processar a mensagem e enviar a resposta
async function processTelegramUpdate(chatId: number, userMessage: string): Promise<void> {
    logger.info(`[Process] Iniciando processamento para chat ${chatId}`);
    try {
        // Feedback visual "digitando..."
        await bot.sendChatAction(chatId, "typing");

        // Chama o fluxo Genkit
        const flowResult = await furiaChatFlow.run(userMessage);
        logger.info(`[Process] Resultado do flow obtido para chat ${chatId}`);

        // Garante que temos uma string para enviar
        let replyText: string;
        if (typeof flowResult === 'string') {
            replyText = flowResult;
        } else {
            // Isso não deveria acontecer se o outputSchema do flow for z.string()
            logger.error(`[Process] Resultado inesperado do flow (não é string): ${typeof flowResult}`, flowResult);
            replyText = "Desculpe, ocorreu um erro interno (formato de resposta inesperado).";
        }
        logger.info(`[Process] Resposta gerada (pronta para envio): "${replyText.substring(0, 100)}..."`);

        // Envia a resposta ao usuário
        await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' }); // Usar Markdown se sua IA gerar formatação
        logger.info(`[Process] Resposta enviada com sucesso para chat ${chatId}.`);

    } catch (error) {
        // Log detalhado do erro ocorrido durante o processamento
        logger.error(`[Process] Erro CRÍTICO ao processar mensagem para chat ${chatId}:`, error);
        try {
            // Tenta enviar uma mensagem de erro mais genérica ao usuário
            await bot.sendMessage(chatId, "🤖 Desculpe, encontrei um problema técnico ao processar sua solicitação. Por favor, tente novamente mais tarde.");
        } catch (sendError) {
            logger.error("[Process] Falha ao enviar mensagem de erro de volta ao Telegram:", sendError);
        }
    }
}


// --- Iniciar o Servidor Express ---
// O Railway fornecerá a porta através da variável de ambiente PORT.
const port = process.env.PORT || 8080; // Porta padrão 8080 se PORT não for definido
app.listen(port, () => {
    logger.info(`Servidor Express iniciado e escutando na porta ${port}`);
    logger.info(`Webhook do Telegram configurado para ser esperado em: ${WEBHOOK_PATH}`);
    // Lembre-se de configurar o webhook no Telegram usando a URL pública do Railway + WEBHOOK_PATH!
    // Ex: https://seu-app.up.railway.app/telegram/webhook/<SEU_TOKEN>
});
