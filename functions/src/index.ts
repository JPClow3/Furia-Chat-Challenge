// functions/src/index.ts

// Importações do Firebase e Node.js
import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import express from 'express';
import cors from 'cors'; // Ensure cors is imported
import * as z from 'zod';

// Importações do Genkit e Plugins VERTEX AI
import {genkit} from 'genkit';
import {gemini20Flash, vertexAI} from '@genkit-ai/vertexai';
// Importação da biblioteca HLTV (Usando default import)
import HLTV from 'hltv';

// Importação da biblioteca Wikipedia e seu tipo
import wiki, {Page} from 'wikipedia';

// --- Definição do Enum TeamPlayerType ---
export enum TeamPlayerType { Coach = 'Coach', Starter = 'Starter', Substitute = 'Substitute', Benched = 'Benched' }

logger.info("Iniciando função com PLUGIN VERTEX AI e Gemini 2.0 Flash...");

// --- Variáveis de Ambiente/Configuração ---
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || functions.config().gcp?.project || '[SEU_PROJECT_ID]';
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || functions.config().gcp?.location || 'us-central1';

if (!GCLOUD_PROJECT || GCLOUD_PROJECT === '[SEU_PROJECT_ID]') {
    logger.error("AVISO: GOOGLE_CLOUD_PROJECT não definido explicitamente via Firebase Config. Verifique seu arquivo functions/.env para o emulador.");
} else {
    logger.info(`GOOGLE_CLOUD_PROJECT configurado como: ${GCLOUD_PROJECT}`);
}

// --- Criar a instância configurada do Genkit (COM VERTEX AI PLUGIN) ---
const ai = genkit({
    plugins: [
        vertexAI({
            projectId: GCLOUD_PROJECT,
            location: GCLOUD_LOCATION,
        })
    ],
});

// --- Ferramentas Customizadas (HLTVs e Wikipedia) ---

// --- Ferramenta 1: Buscar Elenco Atual HLTV ---
const furiaRosterInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool(
    {
        name: "getFuriaRoster",
        description: "Busca a escalação ATUAL detalhada do time FURIA CS2 usando dados da HLTV.",
        inputSchema: furiaRosterInputSchema,
        outputSchema: z.object({
            players: z.array(z.object({
                name: z.string(),
                type: z.nativeEnum(TeamPlayerType)
            })).optional(),
            error: z.string().optional()
        })
    },
    async (_input: z.infer<typeof furiaRosterInputSchema>) => {
        logger.info("[RosterTool] Iniciada busca por elenco da FURIA.");
        try {
            const team = await HLTV.getTeam({id: 8297});
            if (!team?.players?.length) {
                logger.warn("[RosterTool] Elenco não encontrado ou vazio na HLTV.");
                return {error: "Não foi possível encontrar jogadores para a FURIA na HLTV."};
            }
            const playersData = team.players
                .map((p: any) => ({
                    name: p?.name || 'N/D',
                    type: p?.type as TeamPlayerType | undefined
                }))
                .filter((p): p is { name: string; type: TeamPlayerType } => p.name !== 'N/D' && !!p.type);
            if (!playersData.length) {
                logger.warn("[RosterTool] Nenhum jogador válido processado.");
                return {error: "Não foi possível processar jogadores válidos da FURIA."};
            }
            logger.info(`[RosterTool] Elenco encontrado com ${playersData.length} jogadores.`);
            return {players: playersData};
        } catch (err) {
            logger.error("[RosterTool] Erro ao buscar elenco:", err);
            const errorMessage = err instanceof Error ? err.message : "Erro desconhecido na HLTV";
            return {error: `Erro ao buscar elenco: ${errorMessage}`};
        }
    }
);

// --- Ferramenta 2: Próximos Jogos ---
const getFuriaUpcomingMatchesInputSchema = z.object({count: z.number().int().positive().optional().default(5).describe("Número de próximos jogos a retornar.")});
const getFuriaUpcomingMatchesTool = ai.defineTool(
    {
        name: "getFuriaUpcomingMatches",
        description: "Busca os próximos jogos agendados para a FURIA CS2 na HLTV.",
        inputSchema: getFuriaUpcomingMatchesInputSchema,
        outputSchema: z.object({
            matches: z.array(z.object({
                id: z.number().optional(),
                date: z.number().optional().describe("Timestamp Unix da data do jogo"),
                event: z.string().optional(),
                team1: z.string().optional(),
                team2: z.string().optional()
            })).optional(),
            error: z.string().optional()
        })
    },
    async (input: z.infer<typeof getFuriaUpcomingMatchesInputSchema>) => {
        logger.info(`[UpcomingTool] Iniciada busca por ${input.count} próximos jogos.`);
        try {
            const upcomingMatches = await HLTV.getMatches({teamIds: [8297]});
            const now = Date.now();
            const futureMatches = upcomingMatches.filter((match: any) => typeof match.date === 'number' && match.date > now);
            const limitedMatches = futureMatches.slice(0, input.count);
            if (!limitedMatches.length) {
                logger.info("[UpcomingTool] Nenhum próximo jogo encontrado.");
                return {matches: []};
            }
            const formattedMatches = limitedMatches.map((match: any) => ({
                id: match.id,
                date: match.date,
                event: match.event?.name,
                team1: match.team1?.name,
                team2: match.team2?.name
            }));
            logger.info(`[UpcomingTool] ${formattedMatches.length} próximos jogos encontrados.`);
            return {matches: formattedMatches};
        } catch (err) {
            logger.error("[UpcomingTool] Erro ao buscar próximos jogos:", err);
            const errorMessage = err instanceof Error ? err.message : "Erro desconhecido na HLTV";
            return {error: `Erro ao buscar próximos jogos: ${errorMessage}`};
        }
    }
);

// --- Ferramenta 3: Resultados Recentes ---
const getFuriaRecentResultsInputSchema = z.object({count: z.number().int().positive().optional().default(5).describe("Número de resultados recentes a retornar.")});
const getFuriaRecentResultsTool = ai.defineTool(
    {
        name: "getFuriaRecentResults",
        description: "Busca os últimos resultados de jogos da FURIA CS2 na HLTV.",
        inputSchema: getFuriaRecentResultsInputSchema,
        outputSchema: z.object({
            results: z.array(z.object({
                id: z.number().optional(),
                date: z.number().optional().describe("Timestamp Unix da data do jogo"),
                team1: z.string().optional(),
                team2: z.string().optional(),
                result: z.string().optional().describe("Placar final (ex: '13-9')")
            })).optional(),
            error: z.string().optional()
        })
    },
    async (input: z.infer<typeof getFuriaRecentResultsInputSchema>) => {
        logger.info(`[ResultsTool] Iniciada busca por ${input.count} resultados recentes.`);
        try {
            const recentResults: any[] = await HLTV.getResults({teamIds: [8297]});
            const limitedResults = recentResults.slice(0, input.count);
            if (!limitedResults.length) {
                logger.info("[ResultsTool] Nenhum resultado recente encontrado.");
                return {results: []};
            }
            const formattedResults = limitedResults.map((res: any) => {
                let score = 'N/A';
                if (res.result?.team1 != null && res.result?.team2 != null) {
                    score = `${res.result.team1}-${res.result.team2}`;
                }
                return {
                    id: res.id,
                    date: res.date,
                    team1: res.team1?.name,
                    team2: res.team2?.name,
                    result: score
                };
            });
            logger.info(`[ResultsTool] ${formattedResults.length} resultados recentes encontrados.`);
            return {results: formattedResults};
        } catch (err) {
            logger.error("[ResultsTool] Erro ao buscar resultados:", err);
            const errorMessage = err instanceof Error ? err.message : "Erro desconhecido na HLTV";
            return {error: `Erro ao buscar resultados: ${errorMessage}`};
        }
    }
);

// --- Ferramenta 4: Wikipedia ---
const wikipediaInputSchema = z.object({searchTerm: z.string().describe("Tópico exato a ser pesquisado na Wikipedia (ex: 'Furia Esports', 'Gabriel FalleN Toledo').")});
const searchWikipediaTool = ai.defineTool(
    {
        name: "searchWikipedia",
        description: "Busca um resumo de um tópico na Wikipédia em português (PT). Útil para história do time, detalhes sobre jogadores específicos, títulos.",
        inputSchema: wikipediaInputSchema,
        outputSchema: z.object({
            summary: z.string().optional().describe("Resumo do artigo encontrado."),
            url: z.string().optional().describe("URL completa para o artigo na Wikipédia."),
            error: z.string().optional()
        })
    },
    async (input: z.infer<typeof wikipediaInputSchema>) => {
        logger.info("[WikiTool] Buscando na Wikipedia por:", input.searchTerm);
        try {
            await wiki.setLang('pt');
            const page: Page | null = await wiki.page(input.searchTerm);
            if (!page) {
                logger.warn(`[WikiTool] Página não encontrada para "${input.searchTerm}".`);
                return {error: `Página "${input.searchTerm}" não encontrada na Wikipedia.`};
            }
            const summaryResult = await page.summary();
            const url = page.fullurl;
            logger.info(`[WikiTool] Resumo encontrado para "${input.searchTerm}".`);
            return {
                summary: summaryResult.extract || "Resumo não disponível.",
                url: url
            };
        } catch (error) {
            logger.error("[WikiTool] Erro ao buscar na Wikipedia:", error);
            if (error instanceof Error && error.message.includes('No page found')) {
                return {error: `Página "${input.searchTerm}" não encontrada na Wikipedia.`};
            }
            const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido ao acessar a Wikipedia';
            return {error: `Erro na Wikipedia: ${errorMessage}`};
        }
    }
);


// --- Definição do Flow Principal (ai.defineFlow) ---
export const furiaChatFlow = ai.defineFlow(
    {
        name: "furiaChatFlow",
        inputSchema: z.string().describe("Mensagem do usuário para o chatbot."),
        outputSchema: z.string().describe("Resposta do chatbot para o usuário.")
    },
    async (userMessage: string): Promise<string> => {
        logger.info(`[Flow] Mensagem Recebida: "${userMessage}"`);

        const systemInstruction = `Você é um assistente especialista na FURIA CS2. Sua missão é responder perguntas sobre o time, jogadores (atuais e históricos), resultados, próximos jogos e história/títulos, usando as ferramentas disponíveis de forma inteligente.

        **DIRETRIZES:**
        1.  **SEMPRE PRIORIZE AS FERRAMENTAS PARA DADOS ATUAIS/ESPECÍFICOS:**
            *   **Elenco ATUAL:** Use **'getFuriaRoster'** (inclui técnico, titulares, banco).
            *   **PRÓXIMOS JOGOS:** Use **'getFuriaUpcomingMatches'**.
            *   **RESULTADOS RECENTES:** Use **'getFuriaRecentResults'**.
            *   **HISTÓRIA/Detalhes JOGADOR/Títulos:** Use **'searchWikipedia'** (Busque termos precisos como 'Furia Esports' ou 'Gabriel FalleN Toledo'). Se a Wikipedia não tiver, use seu conhecimento interno.
        2.  **USE SEU CONHECIMENTO INTERNO** para:
            *   Responder perguntas gerais sobre a FURIA não cobertas pelas ferramentas (ex: filosofia do time, etc.).
            *   Responder se as ferramentas falharem ou não encontrarem informações (informe sobre a falha).
            *   Contextualizar informações das ferramentas, se necessário.
        3.  **FORA DE ESCOPO:** Se a pergunta for sobre outros times, outros jogos, ou tópicos não relacionados a FURIA CS2, recuse educadamente.
        4.  **TRATAMENTO DE ERROS:** Se uma ferramenta retornar um erro, informe o usuário que não foi possível buscar aquela informação específica (ex: "Não consegui buscar os últimos resultados na HLTV agora.").
        5.  **CLAREZA:** Responda de forma clara e concisa.

        **FORMATAÇÃO DA SAÍDA:** (Use markdown e \\n para novas linhas onde apropriado)
        *   **Elenco:** Liste claramente:
            \\n\\nTécnico:\\n* [Nome]\\n\\nTitulares:\\n* [Nome1]\\n* [Nome2]...\\n\\nBanco/Substitutos:\\n* [Nome] (se houver).
        *   **Jogos/Resultados:** Liste cada partida com data (use o timestamp para deduzir a data/hora se precisar, mas informe como data compreensível se possível), adversário(s), e placar/evento. Use \\n para separar partidas. Ex: \\n* Contra [Time A] em [Data]: Placar [X-Y] ([Evento])
        *   **Wikipedia:** Apresente o resumo de forma clara e inclua o link para a página completa no final. Ex: "Aqui está um resumo sobre [Tópico]:\\n\\n[Resumo]...\\n\\nFonte: [URL]"
        *   **Respostas Gerais:** Use parágrafos curtos.`;

        try {
            const llmResponse = await ai.generate({
                model: gemini20Flash,
                messages: [
                    {role: 'system', content: [{text: systemInstruction}]},
                    {role: 'user', content: [{text: userMessage}]}
                ],
                tools: [
                    getFuriaRosterTool,
                    getFuriaUpcomingMatchesTool,
                    getFuriaRecentResultsTool,
                    searchWikipediaTool,
                ],
                config: {
                    temperature: 0.3
                }
            });

            const botReply = llmResponse.text ?? '';
            const cleanReply = botReply.trim();

            logger.info(`[Flow] Resposta Gerada: "${cleanReply}"`);

            if ((llmResponse as any).usageMetadata) logger.info("[Flow] Usage:", (llmResponse as any).usageMetadata);
            if ((llmResponse as any).candidates?.[0]?.finishReason) logger.info("[Flow] Finish Reason:", (llmResponse as any).candidates[0].finishReason);
            const toolRequests = llmResponse.toolRequests;
            if (toolRequests && toolRequests.length > 0) logger.info("[Flow] Ferramentas Chamadas:", JSON.stringify(toolRequests));

            if (!cleanReply) {
                logger.warn("[Flow] Resposta vazia gerada pelo LLM.");
                return "Não consegui gerar uma resposta para isso no momento.";
            }

            return cleanReply;

        } catch (error) {
            logger.error("[Flow] Erro Crítico durante a execução do flow:", error);
            const errorMessage = error instanceof Error ? error.message : "Erro desconhecido no Flow";
            return `Desculpe, ocorreu um erro interno ao processar sua solicitação: ${errorMessage}`;
        }
    }
);

// --- Configuração do Servidor Express e Rota /chat (Completo e Revisado) ---
const app = express();

// *** CORS Configuration Update ***
// Handle OPTIONS requests (preflight) BEFORE any other middleware or routes that need CORS
// Allow all origins for OPTIONS for simplicity in local dev
app.options('*', cors());

// Then use CORS for all other requests
app.use(cors()); // Allow all origins
// ********************************

app.use(express.json());

app.post('/chat', async (req, res) => {
    logger.info("Recebida requisição POST em /chat", {body: req.body});

    const userMessage = req.body.message;

    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim() === '') {
        logger.warn("Requisição em /chat com mensagem inválida ou vazia.");
        return res.status(400).json({reply: "Erro: Mensagem inválida ou vazia fornecida."});
    }

    try {
        logger.info(`[Rota /chat] Iniciando furiaChatFlow com mensagem: "${userMessage}"`);

        const flowResult = await furiaChatFlow.run(userMessage);

        logger.info(`[Rota /chat] Resultado do flow recebido.`);

        let responseString: string | undefined;
        if (flowResult && typeof (flowResult as any).result === 'string') {
            responseString = (flowResult as any).result;
        } else if (flowResult && typeof (flowResult as any).output === 'string') {
            responseString = (flowResult as any).output;
        }


        if (typeof responseString === 'string') {
            const finalReply = responseString.trim() || "Não consegui encontrar uma resposta para isso.";
            logger.info(`[Rota /chat] Enviando resposta: "${finalReply}"`);
            return res.json({reply: finalReply});
        } else {
            logger.error(`[Rota /chat] Resultado do flow inválido ou não contém string em '.result' ou '.output':`, {result: flowResult});
            return res.status(500).json({reply: "Erro: Formato de resposta interno inesperado."});
        }

    } catch (error) {
        logger.error("[Rota /chat] Erro CRÍTICO ao executar o flow ou processar a requisição:", error);
        const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
        return res.status(500).json({reply: `Desculpe, ocorreu um erro interno grave: ${errorMessage}`});
    }
});

// --- Exportar a API ---
export const api = functions.https.onRequest(app);

logger.info("Função 'api' configurada e pronta (PLUGIN VERTEX AI, Gemini 2.0 Flash) com ferramentas HLTV/Wiki.");