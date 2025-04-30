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
const functions = __importStar(require("firebase-functions/v2"));
const logger = __importStar(require("firebase-functions/logger"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const z = __importStar(require("zod")); // Zod já está importado, necessário para z.infer
// Importações do Genkit e Plugins
const genkit_1 = require("genkit");
const vertexai_1 = require("@genkit-ai/vertexai");
// Importação da biblioteca HLTV
const hltv_1 = __importDefault(require("hltv"));
// Importação da biblioteca Wikipedia
const wikipedia_1 = __importDefault(require("wikipedia"));
dotenv.config();
var TeamPlayerType;
(function (TeamPlayerType) {
    TeamPlayerType["Coach"] = "Coach";
    TeamPlayerType["Starter"] = "Starter";
    TeamPlayerType["Substitute"] = "Substitute";
    TeamPlayerType["Benched"] = "Benched";
})(TeamPlayerType || (exports.TeamPlayerType = TeamPlayerType = {}));
logger.info("Iniciando função com PLUGIN VERTEX AI...");
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION;
if (!GCLOUD_PROJECT || !GCLOUD_LOCATION) {
    logger.error("AVISO: Variáveis GOOGLE_CLOUD_PROJECT ou GOOGLE_CLOUD_LOCATION não definidas no .env.");
}
else {
    logger.info(`GOOGLE_CLOUD_PROJECT: ${GCLOUD_PROJECT}, LOCATION: ${GCLOUD_LOCATION}`);
}
// --- Criar a instância configurada do Genkit com Vertex AI ---
const ai = (0, genkit_1.genkit)({
    plugins: [(0, vertexai_1.vertexAI)({ projectId: GCLOUD_PROJECT, location: GCLOUD_LOCATION })],
});
// --- Tool: Elenco Atual da FURIA (Correções aplicadas) ---
const furiaRosterToolInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool(// Usando ai.defineTool
{
    name: "getFuriaRoster",
    description: "Busca a escalação atual de jogadores do time de CS2 da FURIA Esports diretamente do HLTV.org. Use esta ferramenta sempre que for perguntado sobre os jogadores atuais ou o elenco.",
    inputSchema: furiaRosterToolInputSchema,
    // Schema de Saída CORRIGIDO: Removido 'coach'
    outputSchema: z.object({
        players: z.array(z.object({
            name: z.string().describe("Nome do jogador"),
            type: z.nativeEnum(TeamPlayerType).describe("Posição do jogador (Starter, Substitute, etc.)")
        })).optional().describe("Lista de jogadores ativos e suas posições"),
        error: z.string().optional().describe("Mensagem de erro se a busca falhar"),
    }),
}, async (input) => {
    logger.info("[getFuriaRosterTool] Ferramenta chamada.");
    try {
        const team = await hltv_1.default.getTeam({ id: 8297 });
        if (!team) {
            logger.warn("[getFuriaRosterTool] Objeto 'team' não retornado pelo HLTV para ID 8297.");
            return { error: "Não foi possível obter dados da equipe FURIA no HLTV." };
        }
        const players = team.players
            ?.map(p => ({
            name: p.name || 'Nome Indisponível',
            type: Object.values(TeamPlayerType).includes(p.type) ? p.type : TeamPlayerType.Starter
        }))
            .filter(p => p.name !== 'Nome Indisponível') || [];
        // Lógica do Coach REMOVIDA (const coachName = team.coach?.name;)
        if (players.length === 0) { // Verifica apenas se há jogadores
            logger.warn("[getFuriaRosterTool] Nenhum jogador válido encontrado para a FURIA.");
            return { error: "Não foram encontrados jogadores válidos para a FURIA no HLTV no momento." };
        }
        logger.info(`[getFuriaRosterTool] Jogadores: ${players.map(p => `${p.name} (${p.type})`).join(', ')}`);
        // Retorno CORRIGIDO: Apenas jogadores
        return { players: players };
    }
    catch (err) {
        logger.error("[getFuriaRosterTool] Erro ao buscar dados no HLTV:", err);
        const message = err instanceof Error ? err.message : "Erro desconhecido";
        return { error: `Ocorreu um erro ao tentar buscar os dados no HLTV: ${message}` };
    }
});
// --- Tool: Pesquisa na Wikipedia ---
const wikipediaInputSchema = z.object({ searchTerm: z.string() });
const searchWikipediaTool = ai.defineTool(// Usando ai.defineTool
{
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
        const message = err instanceof Error ? err.message : "Erro desconhecido";
        return { error: `Erro na Wikipedia: ${message}` };
    }
});
// --- Flow Principal do Chat (Correções na obtenção da resposta) ---
exports.furiaChatFlow = ai.defineFlow({ name: "furiaChatFlow", inputSchema: z.string(), outputSchema: z.string() }, async (userMessage) => {
    logger.info(`[Flow] Mensagem Recebida: "${userMessage}"`);
    const systemInstruction = `Você é um assistente especialista focado exclusivamente na equipe de CS2 da FURIA Esports. Responda apenas a perguntas sobre este time.
**IMPORTANTE: Se for perguntado sobre a escalação atual, jogadores ou elenco da FURIA CS2, SEMPRE use a ferramenta 'getFuriaRoster' para obter a informação mais recente do HLTV.org antes de responder.** Liste os jogadores claramente se a ferramenta retornar sucesso.
Se a ferramenta retornar um erro, informe ao usuário que não foi possível buscar os dados atualizados no momento.
Para perguntas gerais sobre a história da FURIA, jogadores específicos (como Fallen, KSCERATO) ou conceitos de CS, você pode usar seu conhecimento ou a ferramenta 'searchWikipedia'.
Se a pergunta for sobre próximos jogos ou resultados recentes, informe que essa funcionalidade ainda não está implementada.
Se a pergunta for sobre qualquer outro assunto não relacionado à FURIA ou CS (outro time, outro jogo, F1, etc.), recuse educadamente informando sua especialidade exclusiva na FURIA CS2.`;
    try {
        const resp = await ai.generate({
            model: 'gemini-2.0-flash', // Usa o ID do modelo como string
            messages: [
                { role: 'system', content: [{ text: systemInstruction }] },
                { role: 'user', content: [{ text: userMessage }] }
            ],
            tools: [getFuriaRosterTool, searchWikipediaTool],
            config: {
                temperature: 0.3
            }
        });
        // ***** OBTENÇÃO DA RESPOSTA CORRIGIDA *****
        const botReply = resp.text ?? 'Não consegui gerar resposta.'; // Acessa .text diretamente
        logger.info(`[furiaChatFlow] Resposta gerada: "${botReply}"`);
        return botReply;
    }
    catch (err) {
        logger.error("[Flow] Erro Crítico:", err);
        return `Desculpe, erro interno: ${err.message}`;
    }
});
// --- Configuração do Servidor Express ---
const app = (0, express_1.default)();
app.use(express_1.default.json());
// --- Rota de Chat USA O FLOW (Correção no return) ---
// Removido ': Promise<void>' para evitar conflito com return implícito do Express
app.post("/chat", async (req, res) => {
    const userMessage = req.body.message;
    if (!userMessage?.trim()) {
        // CORRIGIDO: Removido 'return'
        res.status(400).json({ reply: "Mensagem inválida." });
        return; // Use return aqui para parar a execução APÓS enviar a resposta
    }
    try {
        logger.info(`[Rota /chat] Chamando furiaChatFlow com: "${userMessage}"`);
        const flowResult = await exports.furiaChatFlow.run(userMessage);
        logger.info(`[Rota /chat] Flow completed. Tipo: ${typeof flowResult}, Valor Raw: ${JSON.stringify(flowResult)}`);
        let responsePayload = "Erro: Resposta não encontrada no resultado do flow.";
        if (typeof flowResult === 'object' && flowResult !== null && typeof flowResult.result === 'string') {
            responsePayload = flowResult.result;
        }
        else if (typeof flowResult === 'string') {
            responsePayload = flowResult;
        }
        else {
            logger.warn(`[Rota /chat] Estrutura de resultado inesperada do flow: ${JSON.stringify(flowResult)}`);
        }
        logger.info(`[Rota /chat] Enviando payload: "${responsePayload}"`);
        // CORRIGIDO: Removido 'return'
        res.json({ reply: responsePayload });
    }
    catch (err) {
        logger.error("Erro em /chat:", err);
        const errorMessage = err instanceof Error ? err.message : "Ocorreu um erro interno desconhecido.";
        // CORRIGIDO: Removido 'return'
        res.status(500).json({ reply: `Erro interno ao processar sua mensagem. Detalhe: ${errorMessage}` });
    }
});
// --- CORS Handler ---
const corsHandler = (0, cors_1.default)({
    origin: ["http://127.0.0.1:5000", "http://localhost:5000"],
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
});
// --- Exportar a API como uma Cloud Function HTTP v2 ---
exports.api = functions.https.onRequest((req, res) => {
    corsHandler(req, res, () => {
        if (req.method === "OPTIONS") {
            res.status(204).send("");
        }
        else {
            app(req, res); // Encaminha para o Express
        }
    });
});
logger.info("Função 'api' pronta com CORS wrapper e JSON parsing.");
//# sourceMappingURL=index.js.map