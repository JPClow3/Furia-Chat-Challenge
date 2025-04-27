// functions/src/index.ts

// Importações do Firebase e Node.js
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

// --- Definição do Enum TeamPlayerType ---
export enum TeamPlayerType { Coach = 'Coach', Starter = 'Starter', Substitute = 'Substitute', Benched = 'Benched' }

logger.info("Iniciando função com PLUGIN VERTEX AI e Gemini 2.0 Flash...");

// --- Variáveis de Ambiente/Configuração ---
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || functions.config().gcp?.project || '[SEU_PROJECT_ID]';
const GCLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || functions.config().gcp?.location || 'us-central1';

if (!GCLOUD_PROJECT || GCLOUD_PROJECT === '[SEU_PROJECT_ID]') {
    logger.error("AVISO: GOOGLE_CLOUD_PROJECT não definido explicitamente via Firebase Config ou .env. Verifique seu arquivo functions/.env para o emulador.");
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

// Ferramenta 1: Elenco HLTV
const furiaRosterInputSchema = z.object({});
const getFuriaRosterTool = ai.defineTool(
    { name: "getFuriaRoster", description: "Busca a escalação ATUAL detalhada do time FURIA CS2 usando dados da HLTV.", inputSchema: furiaRosterInputSchema, outputSchema: z.object({ players: z.array(z.object({ name: z.string(), type: z.nativeEnum(TeamPlayerType) })).optional().describe("Lista de jogadores e seus tipos (Coach, Starter, Substitute, Benched)."), error: z.string().optional().describe("Mensagem de erro, se a busca falhar.") }) },
    async (_input) => { logger.info("[Tool:getFuriaRoster] Iniciada busca por elenco da FURIA."); try { const team = await HLTV.getTeam({ id: 8297 }); if (!team?.players?.length) { logger.warn("[Tool:getFuriaRoster] Elenco não encontrado ou vazio na HLTV."); return { error: "Não foi possível encontrar jogadores para a FURIA na HLTV." }; } const playersData = team.players.map((p: any) => ({ name: p?.name || 'N/D', type: p?.type as TeamPlayerType | undefined })).filter((p): p is { name: string; type: TeamPlayerType } => p.name !== 'N/D' && !!p.type); if (!playersData.length) { logger.warn("[Tool:getFuriaRoster] Nenhum jogador válido processado."); return { error: "Não foi possível processar jogadores válidos da FURIA." }; } logger.info(`[Tool:getFuriaRoster] Elenco encontrado com ${playersData.length} jogadores.`); return { players: playersData }; } catch (err) { logger.error("[Tool:getFuriaRoster] Erro ao buscar elenco:", err); const errorMessage = err instanceof Error ? err.message : "Erro desconhecido na HLTV"; return { error: `Erro ao buscar elenco: ${errorMessage}` }; } }
);

// Ferramenta 2: Próximos Jogos
const getFuriaUpcomingMatchesInputSchema = z.object({ count: z.number().int().positive().optional().default(5).describe("Número de próximos jogos a retornar (padrão 5).") });
const getFuriaUpcomingMatchesTool = ai.defineTool(
    { name: "getFuriaUpcomingMatches", description: "Busca os próximos jogos agendados para a FURIA CS2 na HLTV.", inputSchema: getFuriaUpcomingMatchesInputSchema, outputSchema: z.object({ matches: z.array(z.object({ id: z.number().optional(), date: z.number().optional().describe("Timestamp Unix da data/hora do jogo em milissegundos."), event: z.string().optional().describe("Nome do evento/campeonato."), team1: z.string().optional().describe("Nome do time 1."), team2: z.string().optional().describe("Nome do time 2.") })).optional().describe("Lista dos próximos jogos encontrados."), error: z.string().optional().describe("Mensagem de erro, se a busca falhar.") }) },
    async (input) => { logger.info(`[Tool:getFuriaUpcomingMatches] Iniciada busca por ${input.count} próximos jogos.`); try { const upcomingMatches = await HLTV.getMatches({ teamIds: [8297] }); const now = Date.now(); const futureMatches = upcomingMatches.filter((match: any) => typeof match.date === 'number' && match.date > now); const limitedMatches = futureMatches.slice(0, input.count); if (!limitedMatches.length) { logger.info("[Tool:getFuriaUpcomingMatches] Nenhum próximo jogo encontrado."); return { matches: [] }; } const formattedMatches = limitedMatches.map((match: any) => ({ id: match.id, date: match.date, event: match.event?.name, team1: match.team1?.name, team2: match.team2?.name })); logger.info(`[Tool:getFuriaUpcomingMatches] ${formattedMatches.length} próximos jogos encontrados.`); return { matches: formattedMatches }; } catch (err) { logger.error("[Tool:getFuriaUpcomingMatches] Erro ao buscar próximos jogos:", err); const errorMessage = err instanceof Error ? err.message : "Erro desconhecido na HLTV"; return { error: `Erro ao buscar próximos jogos: ${errorMessage}` }; } }
);

// Ferramenta 3: Resultados Recentes
const getFuriaRecentResultsInputSchema = z.object({ count: z.number().int().positive().optional().default(5).describe("Número de resultados recentes a retornar (padrão 5).") });
const getFuriaRecentResultsTool = ai.defineTool(
    { name: "getFuriaRecentResults", description: "Busca os últimos resultados de jogos da FURIA CS2 na HLTV.", inputSchema: getFuriaRecentResultsInputSchema, outputSchema: z.object({ results: z.array(z.object({ id: z.number().optional(), date: z.number().optional().describe("Timestamp Unix da data/hora do jogo em milissegundos."), team1: z.string().optional().describe("Nome do time 1."), team2: z.string().optional().describe("Nome do time 2."), result: z.string().optional().describe("Placar final (ex: '13-9') ou status (ex: 'Perda por W.O.').") })).optional().describe("Lista dos resultados recentes encontrados."), error: z.string().optional().describe("Mensagem de erro, se a busca falhar.") }) },
    async (input) => { logger.info(`[Tool:getFuriaRecentResults] Iniciada busca por ${input.count} resultados recentes.`); try { const recentResults: any[] = await HLTV.getResults({ teamIds: [8297] }); const limitedResults = recentResults.slice(0, input.count); if (!limitedResults.length) { logger.info("[Tool:getFuriaRecentResults] Nenhum resultado recente encontrado."); return { results: [] }; } const formattedResults = limitedResults.map((res: any) => { let score = 'N/A'; if (res.result?.team1 != null && res.result?.team2 != null) { score = `${res.result.team1}-${res.result.team2}`; } else if ((res.result as any)?.outcome) { score = (res.result as any).outcome; } return { id: res.id, date: res.date, team1: res.team1?.name, team2: res.team2?.name, result: score }; }); logger.info(`[Tool:getFuriaRecentResults] ${formattedResults.length} resultados recentes encontrados.`); return { results: formattedResults }; } catch (err) { logger.error("[Tool:getFuriaRecentResults] Erro ao buscar resultados:", err); const errorMessage = err instanceof Error ? err.message : "Erro desconhecido na HLTV"; return { error: `Erro ao buscar resultados: ${errorMessage}` }; } }
);

// Ferramenta 4: Wikipedia
const wikipediaInputSchema = z.object({ searchTerm: z.string().describe("Tópico exato a ser pesquisado na Wikipedia em português (ex: 'Furia Esports', 'Gabriel FalleN Toledo', 'Kaike KSCERATO Cerato'). Seja o mais específico possível.") });
const searchWikipediaTool = ai.defineTool(
    { name: "searchWikipedia", description: "Busca um resumo de um tópico na Wikipédia em português (PT). Útil para história do time, detalhes sobre jogadores específicos, títulos ou eventos passados relacionados à FURIA.", inputSchema: wikipediaInputSchema, outputSchema: z.object({ summary: z.string().optional().describe("Resumo do artigo encontrado na Wikipedia."), url: z.string().url().optional().describe("URL completa para o artigo na Wikipédia."), error: z.string().optional().describe("Mensagem de erro, se a busca falhar ou a página não for encontrada.") }) },
    async (input) => { logger.info("[Tool:searchWikipedia] Buscando na Wikipedia por:", input.searchTerm); try { await wiki.setLang('pt'); const page: Page | null = await wiki.page(input.searchTerm); if (!page) { logger.warn(`[Tool:searchWikipedia] Página não encontrada para "${input.searchTerm}".`); return { error: `Página "${input.searchTerm}" não encontrada na Wikipedia.` }; } const summaryResult = await page.summary(); const url = page.fullurl; logger.info(`[Tool:searchWikipedia] Resumo encontrado para "${input.searchTerm}". URL: ${url}`); return { summary: summaryResult.extract || "Resumo não disponível.", url: url }; } catch (error) { logger.error("[Tool:searchWikipedia] Erro ao buscar na Wikipedia:", error); if (error instanceof Error && (error.message.includes('No page found') || error.message.includes('Not found.'))) { return { error: `Página "${input.searchTerm}" não encontrada na Wikipedia.` }; } const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido ao acessar a Wikipedia'; return { error: `Erro na Wikipedia: ${errorMessage}` }; } }
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

        const systemInstruction = `Você é um assistente especialista na FURIA Esports de CS (Counter-Strike). Sua missão é responder perguntas sobre o time, jogadores (atuais e históricos), resultados recentes, próximos jogos agendados, história e títulos da organização, usando as ferramentas disponíveis. Seja informativo, conciso e mantenha o tom profissional, mas amigável, de um representante da FURIA.

        **DIRETRIZES E USO DAS FERRAMENTAS:**
        1.  **Entenda a Pergunta:** Analise cuidadosamente o que o usuário está perguntando (elenco atual? próximos jogos? resultados? história? jogador específico?).
        2.  **Selecione a Ferramenta Correta:**
            *   **Elenco ATUAL Completo (com técnico, etc.):** Use **'getFuriaRoster'**.
            *   **PRÓXIMOS JOGOS Agendados:** Use **'getFuriaUpcomingMatches'**.
            *   **ÚLTIMOS RESULTADOS:** Use **'getFuriaRecentResults'**.
            *   **HISTÓRIA DO TIME, TÍTULOS, DETALHES SOBRE JOGADORES ESPECÍFICOS (incluindo carreira passada, etc.):** Use **'searchWikipedia'** com termos precisos (ex: 'Furia Esports', 'Gabriel FalleN Toledo', 'Kaike KSCERATO Cerato').
        3.  **Conhecimento Interno:** Se a pergunta for mais geral sobre a FURIA (filosofia, etc.) e não coberta por ferramentas, use seu conhecimento. Se uma ferramenta falhar ou não encontrar dados (ex: nenhum jogo futuro agendado), informe isso claramente baseado na resposta da ferramenta (ou na ausência de dados nela) em vez de dizer que não sabe.
        4.  **Seja Específico:** Para a Wikipedia, peça ao usuário o nome completo e correto se a busca inicial falhar por ambiguidade.
        5.  **Tratamento de Erros:** Se uma ferramenta retornar um erro técnico (ex: 'Erro ao buscar elenco: ...'), informe ao usuário de forma simplificada (ex: "Desculpe, não consegui buscar o elenco atual neste momento devido a um erro na HLTV.") NÃO exponha detalhes técnicos do erro da ferramenta diretamente ao usuário.
        6.  **FORA DE ESCOPO:** Perguntas sobre outros times, outros jogos (ex: Valorant da FURIA), ou assuntos não relacionados devem ser educadamente recusadas. Mantenha o foco no CS da FURIA.

        **FORMATAÇÃO DA SAÍDA (Use Markdown):**
        *   **Elenco:** Use listas claras e separe por função. Exemplo:
            \`\`\`
            O elenco atual da FURIA CS é:

            **Técnico:**
            * Nicholas 'guerri' Nogueira

            **Titulares:**
            * Yuri 'yuurih' Santos
            * Andrei 'arT' Piovezan
            * Kaike 'KSCERATO' Cerato
            * Gabriel 'FalleN' Toledo
            * Marcelo 'chelo' Cespedes

            **Banco/Substitutos:**
            * (Liste se houver na resposta da ferramenta)
            \`\`\`
        *   **Jogos/Resultados:** Liste cada partida com data (formatada como DD/MM/AAAA se possível, caso contrário mencione o timestamp ou 'em breve'), adversário(s), e placar/evento. Use bullet points. Ex:
            *   Contra **[Time Adversário]** em [Data Formatada ou 'Breve'] ([Nome do Evento])
            *   Contra **[Time Adversário]** em [Data Formatada]: **[Placar FURIA]-[Placar Adv]** ([Nome do Evento])
        *   **Wikipedia:** Apresente o resumo de forma clara e inclua o link para a página completa no final. Ex:
            Aqui está um resumo sobre **[Tópico]**:

            [Resumo conciso e relevante da ferramenta]...

            Fonte: [URL da Wikipedia]
        *   **Respostas Gerais:** Use parágrafos curtos e formatação markdown básica (negrito, itálico) se apropriado.`;

        try {
            const llmResponse = await ai.generate({
                model: gemini20Flash,
                messages: [
                    { role: 'system', content: [{ text: systemInstruction }] },
                    { role: 'user', content: [{ text: userMessage }] }
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

            // Log de metadados de uso, se disponível
            if (llmResponse.usage) {
                logger.info("[Flow] Usage:", JSON.stringify(llmResponse.usage));
            }
            // Log das chamadas de ferramenta feitas pelo modelo
            const toolRequests = llmResponse.toolRequests; // É um getter/propriedade
            if (toolRequests && toolRequests.length > 0) {
                logger.info("[Flow] Ferramentas Chamadas:", JSON.stringify(toolRequests));
            }

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

// --- Configuração do Servidor Express e Rota /chat ---
const app = express();

const allowedOrigins = ['http://127.0.0.1:5000', 'http://localhost:5000'];
const corsOptions: cors.CorsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            logger.error(`CORS Error: Origin ${origin} not allowed.`);
            callback(new Error(`Origin ${origin} Not allowed by CORS`));
        }
    },
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());

app.post('/chat', async (req, res) => {
    logger.info("Recebida requisição POST em /chat", { body: req.body });
    const userMessage = req.body.message;

    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim() === '') {
        logger.warn("Requisição em /chat com mensagem inválida ou vazia.");
        return res.status(400).json({ reply: "Erro: Mensagem inválida ou vazia fornecida." });
    }

    try {
        logger.info(`[Rota /chat] Iniciando furiaChatFlow com mensagem: "${userMessage}"`);

        // .run() retorna um objeto { output: string } ou lança erro
        const flowExecutionResult = await furiaChatFlow.run(userMessage); // Remove :string annotation

        logger.info(`[Rota /chat] Resultado do flow recebido: ${typeof flowExecutionResult}`);

        // Extrai o resultado do objeto retornado por .run()
        // Genkit v1+ tipicamente usa 'output', mas verificamos 'result' por segurança
        const responseString = (flowExecutionResult as any)?.output ?? (flowExecutionResult as any)?.result;

        if (typeof responseString === 'string') {
            const finalReply = responseString.trim() || "Não consegui encontrar uma resposta para isso.";
            logger.info(`[Rota /chat] Enviando resposta: "${finalReply}"`);
            return res.json({ reply: finalReply });
        } else {
            logger.error(`[Rota /chat] Resultado inesperado do flow (output/result não é string):`, { result: flowExecutionResult });
            return res.status(500).json({ reply: "Erro: Formato de resposta interno inesperado." });
        }

    } catch (error) {
        logger.error("[Rota /chat] Erro CRÍTICO ao executar o flow ou processar a requisição:", error);
        const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
        return res.status(500).json({ reply: `Desculpe, ocorreu um erro interno grave: ${errorMessage}` });
    }
});

// --- Exportar a API ---
export const api = functions.https.onRequest(app);

logger.info("Função 'api' configurada e pronta (PLUGIN VERTEX AI, Gemini 2.0 Flash) com ferramentas HLTV/Wiki.");