"use strict";
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
// Importações do Firebase, Node.js e variáveis de ambiente
const dotenv = __importStar(require("dotenv"));
const functions = __importStar(require("firebase-functions/v2"));
const logger = __importStar(require("firebase-functions/logger"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const z = __importStar(require("zod"));
// Importações do Genkit e Plugins VERTEX AI
const genkit_1 = require("genkit");
const vertexai_1 = require("@genkit-ai/vertexai");
// Importação da biblioteca HLTV
const hltv_1 = __importDefault(require("hltv"));
// Importação da biblioteca Wikipedia
const wikipedia_1 = __importDefault(require("wikipedia"));
dotenv.config();
// --- Definição do Enum TeamPlayerType ---
var TeamPlayerType;
(function (TeamPlayerType) {
    TeamPlayerType["Coach"] = "Coach";
    TeamPlayerType["Starter"] = "Starter";
    TeamPlayerType["Substitute"] = "Substitute";
    TeamPlayerType["Benched"] = "Benched";
})(TeamPlayerType || (exports.TeamPlayerType = TeamPlayerType = {}));
logger.info("Iniciando função com PLUGIN VERTEX AI e Gemini 2.0 Flash...");
// --- Variáveis de Ambiente/Configuração ---
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION;
if (!GCLOUD_PROJECT || !GCLOUD_LOCATION) {
    logger.error("AVISO: Variáveis GOOGLE_CLOUD_PROJECT ou GOOGLE_CLOUD_LOCATION não definidas no .env.");
}
else {
    logger.info(`GOOGLE_CLOUD_PROJECT: ${GCLOUD_PROJECT}, LOCATION: ${GCLOUD_LOCATION}`);
}
// --- Instância Genkit com Vertex AI ---
const ai = (0, genkit_1.genkit)({
    plugins: [
        (0, vertexai_1.vertexAI)({ projectId: GCLOUD_PROJECT, location: GCLOUD_LOCATION }),
    ],
});
// --- Tool: Elenco Atual da FURIA ---
const furiaRosterInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool({
    name: "getFuriaRoster",
    description: "Busca a escalação ATUAL detalhada do time FURIA CS2 usando dados da HLTV.",
    inputSchema: furiaRosterInputSchema,
    outputSchema: z.object({
        players: z
            .array(z.object({ name: z.string(), type: z.nativeEnum(TeamPlayerType) }))
            .optional()
            .describe("Lista de jogadores e seus tipos (Coach, Starter, Substitute, Benched)."),
        error: z.string().optional().describe("Mensagem de erro, se a busca falhar."),
    }),
}, async (_input) => {
    logger.info("[Tool:getFuriaRoster] Iniciada busca por elenco da FURIA.");
    try {
        const team = await hltv_1.default.getTeam({ id: 8297 });
        if (!team?.players?.length) {
            return { error: "Não foi possível encontrar jogadores para a FURIA na HLTV." };
        }
        const players = team.players
            .map((p) => ({ name: p.name, type: p.type }))
            .filter(p => p.name && p.type);
        return { players };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        return { error: `Erro ao buscar elenco: ${msg}` };
    }
});
// --- Tool: Próximos Jogos da FURIA ---
const getFuriaUpcomingMatchesInputSchema = z.object({
    count: z.number().int().positive().optional().default(5),
});
const getFuriaUpcomingMatchesTool = ai.defineTool({
    name: "getFuriaUpcomingMatches",
    description: "Busca os próximos jogos agendados para a FURIA CS2 na HLTV.",
    inputSchema: getFuriaUpcomingMatchesInputSchema,
    outputSchema: z.object({
        matches: z
            .array(z.object({
            id: z.number().optional(),
            date: z.number().optional().describe("Timestamp Unix em ms."),
            event: z.string().optional(),
            team1: z.string().optional(),
            team2: z.string().optional(),
        }))
            .optional(),
        error: z.string().optional(),
    }),
}, async (input) => {
    logger.info(`[Tool:getFuriaUpcomingMatches] Buscando ${input.count} jogos.`);
    try {
        const matches = await hltv_1.default.getMatches({ teamIds: [8297] });
        const upcoming = matches
            .filter(m => typeof m.date === 'number' && m.date > Date.now())
            .slice(0, input.count)
            .map(m => ({ id: m.id, date: m.date, event: m.event?.name, team1: m.team1?.name, team2: m.team2?.name }));
        return { matches: upcoming };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        return { error: `Erro ao buscar próximos jogos: ${msg}` };
    }
});
// --- Tool: Resultados Recentes da FURIA ---
const getFuriaRecentResultsInputSchema = z.object({
    count: z.number().int().positive().optional().default(5),
});
const getFuriaRecentResultsTool = ai.defineTool({
    name: "getFuriaRecentResults",
    description: "Busca os últimos resultados de jogos da FURIA CS2 na HLTV.",
    inputSchema: getFuriaRecentResultsInputSchema,
    outputSchema: z.object({
        results: z
            .array(z.object({
            id: z.number().optional(),
            date: z.number().optional(),
            team1: z.string().optional(),
            team2: z.string().optional(),
            result: z.string().optional(),
        }))
            .optional(),
        error: z.string().optional(),
    }),
}, async (input) => {
    logger.info(`[Tool:getFuriaRecentResults] Buscando ${input.count} resultados.`);
    try {
        const res = await hltv_1.default.getResults({ teamIds: [8297] });
        const results = res.slice(0, input.count).map(r => {
            let score = 'N/A';
            if (r.result?.team1 != null && r.result?.team2 != null) {
                score = `${r.result.team1}-${r.result.team2}`;
            }
            else if (r.result?.outcome) {
                score = r.result.outcome;
            }
            return { id: r.id, date: r.date, team1: r.team1?.name, team2: r.team2?.name, result: score };
        });
        return { results };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        return { error: `Erro ao buscar resultados: ${msg}` };
    }
});
// --- Tool: Pesquisa na Wikipedia ---
const wikipediaInputSchema = z.object({ searchTerm: z.string() });
const searchWikipediaTool = ai.defineTool({
    name: "searchWikipedia",
    description: "Resumo de tópico em Português na Wikipedia.",
    inputSchema: wikipediaInputSchema,
    outputSchema: z.object({ summary: z.string().optional(), url: z.string().optional(), error: z.string().optional() }),
}, async ({ searchTerm }) => {
    logger.info(`[Tool:searchWikipedia] Buscando '${searchTerm}'.`);
    try {
        await wikipedia_1.default.setLang('pt');
        const page = await wikipedia_1.default.page(searchTerm);
        if (!page) {
            return { error: `Página '${searchTerm}' não encontrada.` };
        }
        const summary = await page.summary();
        return { summary: summary.extract, url: page.fullurl };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        return { error: `Erro na Wikipedia: ${msg}` };
    }
});
// --- Flow Principal ---
exports.furiaChatFlow = ai.defineFlow({ name: "furiaChatFlow", inputSchema: z.string(), outputSchema: z.string() }, async (userMessage) => {
    logger.info(`[Flow] Mensagem Recebida: "${userMessage}"`);
    const systemInstruction = `Você é um assistente...`;
    try {
        const resp = await ai.generate({
            model: vertexai_1.gemini20Flash,
            messages: [
                { role: 'system', content: [{ text: systemInstruction }] },
                { role: 'user', content: [{ text: userMessage }] },
            ],
            tools: [getFuriaRosterTool, getFuriaUpcomingMatchesTool, getFuriaRecentResultsTool, searchWikipediaTool],
            config: { temperature: 0.3 },
        });
        return resp.text?.trim() || 'Não consegui gerar resposta.';
    }
    catch (err) {
        logger.error("[Flow] Erro Crítico:", err);
        return `Desculpe, erro interno: ${err.message}`;
    }
});
// --- Express + JSON Parsing ---
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Rota de chat
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;
    if (!userMessage?.trim()) {
        res.status(400).json({ reply: 'Mensagem inválida.' });
        return;
    }
    try {
        const output = await exports.furiaChatFlow.run(userMessage);
        res.json({ reply: output });
    }
    catch (err) {
        logger.error("Erro em /chat:", err);
        res.status(500).json({ reply: 'Erro interno.' });
    }
});
// --- CORS Handler e Exportação da Cloud Function ---
const corsHandler = (0, cors_1.default)({
    origin: ['http://127.0.0.1:5000', 'http://localhost:5000'],
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
});
exports.api = functions.https.onRequest((req, res) => {
    corsHandler(req, res, () => {
        if (req.method === 'OPTIONS') {
            // Responde preflight CORS
            res.status(204).send('');
        }
        else {
            // Encaminha para o Express
            app(req, res);
        }
    });
});
logger.info("Função 'api' pronta com CORS wrapper e JSON parsing.");
//# sourceMappingURL=index.js.map