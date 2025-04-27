// functions/src/index.ts

// Importações do Firebase, Node.js e variáveis de ambiente
import * as dotenv from 'dotenv';
import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import express from 'express';
import cors from 'cors';
import * as z from 'zod';

// Importações do Genkit e Plugins VERTEX AI
import {genkit} from 'genkit';
import {gemini20Flash, vertexAI} from '@genkit-ai/vertexai';
// Importação da biblioteca HLTV
import HLTV from 'hltv';
// Importação da biblioteca Wikipedia
import wiki, {Page} from 'wikipedia';

dotenv.config();

// --- Definição do Enum TeamPlayerType ---
export enum TeamPlayerType {
    Coach = 'Coach',
    Starter = 'Starter',
    Substitute = 'Substitute',
    Benched = 'Benched'
}

logger.info("Iniciando função com PLUGIN VERTEX AI e Gemini 2.0 Flash...");

// --- Variáveis de Ambiente/Configuração ---
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT!;
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION!;

if (!GCLOUD_PROJECT || !GCLOUD_LOCATION) {
    logger.error(
        "AVISO: Variáveis GOOGLE_CLOUD_PROJECT ou GOOGLE_CLOUD_LOCATION não definidas no .env."
    );
} else {
    logger.info(`GOOGLE_CLOUD_PROJECT: ${GCLOUD_PROJECT}, LOCATION: ${GCLOUD_LOCATION}`);
}

// --- Instância Genkit com Vertex AI ---
const ai = genkit({
    plugins: [
        vertexAI({ projectId: GCLOUD_PROJECT, location: GCLOUD_LOCATION }),
    ],
});

// --- Tool: Elenco Atual da FURIA ---
const furiaRosterInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool(
    {
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
    },
    async (_input) => {
        logger.info("[Tool:getFuriaRoster] Iniciada busca por elenco da FURIA.");
        try {
            const team = await HLTV.getTeam({ id: 8297 });
            if (!team?.players?.length) {
                return { error: "Não foi possível encontrar jogadores para a FURIA na HLTV." };
            }
            const players = team.players
                .map((p: any) => ({ name: p.name, type: p.type as TeamPlayerType }))
                .filter(p => p.name && p.type);
            return { players };
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Erro desconhecido';
            return { error: `Erro ao buscar elenco: ${msg}` };
        }
    }
);

// --- Tool: Próximos Jogos da FURIA ---
const getFuriaUpcomingMatchesInputSchema = z.object({
    count: z.number().int().positive().optional().default(5),
});
const getFuriaUpcomingMatchesTool = ai.defineTool(
    {
        name: "getFuriaUpcomingMatches",
        description: "Busca os próximos jogos agendados para a FURIA CS2 na HLTV.",
        inputSchema: getFuriaUpcomingMatchesInputSchema,
        outputSchema: z.object({
            matches: z
                .array(
                    z.object({
                        id: z.number().optional(),
                        date: z.number().optional().describe("Timestamp Unix em ms."),
                        event: z.string().optional(),
                        team1: z.string().optional(),
                        team2: z.string().optional(),
                    })
                )
                .optional(),
            error: z.string().optional(),
        }),
    },
    async (input) => {
        logger.info(`[Tool:getFuriaUpcomingMatches] Buscando ${input.count} jogos.`);
        try {
            const matches = await HLTV.getMatches({ teamIds: [8297] });
            const upcoming = matches
                .filter(m => typeof m.date === 'number' && m.date! > Date.now())
                .slice(0, input.count)
                .map(m => ({ id: m.id, date: m.date, event: m.event?.name, team1: m.team1?.name, team2: m.team2?.name }));
            return { matches: upcoming };
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Erro desconhecido';
            return { error: `Erro ao buscar próximos jogos: ${msg}` };
        }
    }
);

// --- Tool: Resultados Recentes da FURIA ---
const getFuriaRecentResultsInputSchema = z.object({
    count: z.number().int().positive().optional().default(5),
});
const getFuriaRecentResultsTool = ai.defineTool(
    {
        name: "getFuriaRecentResults",
        description: "Busca os últimos resultados de jogos da FURIA CS2 na HLTV.",
        inputSchema: getFuriaRecentResultsInputSchema,
        outputSchema: z.object({
            results: z
                .array(
                    z.object({
                        id: z.number().optional(),
                        date: z.number().optional(),
                        team1: z.string().optional(),
                        team2: z.string().optional(),
                        result: z.string().optional(),
                    })
                )
                .optional(),
            error: z.string().optional(),
        }),
    },
    async (input) => {
        logger.info(`[Tool:getFuriaRecentResults] Buscando ${input.count} resultados.`);
        try {
            const res = await HLTV.getResults({ teamIds: [8297] });
            const results = res.slice(0, input.count).map(r => {
                let score = 'N/A';
                if (r.result?.team1 != null && r.result?.team2 != null) {
                    score = `${r.result.team1}-${r.result.team2}`;
                } else if ((r.result as any)?.outcome) {
                    score = (r.result as any).outcome;
                }
                return { id: r.id, date: r.date, team1: r.team1?.name, team2: r.team2?.name, result: score };
            });
            return { results };
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Erro desconhecido';
            return { error: `Erro ao buscar resultados: ${msg}` };
        }
    }
);

// --- Tool: Pesquisa na Wikipedia ---
const wikipediaInputSchema = z.object({ searchTerm: z.string() });
const searchWikipediaTool = ai.defineTool(
    {
        name: "searchWikipedia",
        description: "Resumo de tópico em Português na Wikipedia.",
        inputSchema: wikipediaInputSchema,
        outputSchema: z.object({ summary: z.string().optional(), url: z.string().optional(), error: z.string().optional() }),
    },
    async ({ searchTerm }) => {
        logger.info(`[Tool:searchWikipedia] Buscando '${searchTerm}'.`);
        try {
            await wiki.setLang('pt');
            const page: Page | null = await wiki.page(searchTerm);
            if (!page) {
                return { error: `Página '${searchTerm}' não encontrada.` };
            }
            const summary = await page.summary();
            return { summary: summary.extract, url: page.fullurl };
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Erro desconhecido';
            return { error: `Erro na Wikipedia: ${msg}` };
        }
    }
);

// --- Flow Principal ---
export const furiaChatFlow = ai.defineFlow(
    { name: "furiaChatFlow", inputSchema: z.string(), outputSchema: z.string() },
    async (userMessage: string) => {
        logger.info(`[Flow] Mensagem Recebida: "${userMessage}"`);
        const systemInstruction = `Você é um assistente...`;
        try {
            const resp = await ai.generate({
                model: gemini20Flash,
                messages: [
                    { role: 'system', content: [{ text: systemInstruction }] },
                    { role: 'user', content: [{ text: userMessage }] },
                ],
                tools: [getFuriaRosterTool, getFuriaUpcomingMatchesTool, getFuriaRecentResultsTool, searchWikipediaTool],
                config: { temperature: 0.3 },
            });
            return resp.text?.trim() || 'Não consegui gerar resposta.';
        } catch (err) {
            logger.error("[Flow] Erro Crítico:", err);
            return `Desculpe, erro interno: ${(err as Error).message}`;
        }
    }
);

// --- Express + JSON Parsing ---
const app = express();
app.use(express.json());

// Rota de chat
app.post('/chat', async (req, res): Promise<void> => {
    const userMessage = req.body.message;
    if (!userMessage?.trim()) {
        res.status(400).json({ reply: 'Mensagem inválida.' });
        return;
    }
    try {
        const output = await furiaChatFlow.run(userMessage);
        res.json({ reply: output });
    } catch (err) {
        logger.error("Erro em /chat:", err);
        res.status(500).json({ reply: 'Erro interno.' });
    }
});

// --- CORS Handler e Exportação da Cloud Function ---
const corsHandler = cors({
    origin: ['http://127.0.0.1:5000', 'http://localhost:5000'],
    methods: ['POST','OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
});

export const api = functions.https.onRequest((req, res) => {
    corsHandler(req, res, () => {
        if (req.method === 'OPTIONS') {
            // Responde preflight CORS
            res.status(204).send('');
        } else {
            // Encaminha para o Express
            app(req, res);
        }
    });
});

logger.info("Função 'api' pronta com CORS wrapper e JSON parsing.");
