# FURIOSO - Chatbot da FURIA CS2

## Descrição

**FURIOSO** é um chatbot para Telegram especializado em fornecer informações atualizadas sobre a equipe de Counter-Strike 2 (CS2) da **FURIA Esports**. Ele utiliza o framework Genkit AI com o modelo Gemini Flash do Google AI para entender e responder a perguntas em linguagem natural, além de buscar dados em diversas fontes externas através de ferramentas customizadas. O bot também responde a comandos rápidos para informações específicas.

Este projeto foi desenvolvido com foco em fornecer dados precisos sobre elenco, próximas partidas, resultados recentes e notícias da FURIA, utilizando cache para otimizar a velocidade e reduzir o uso de APIs externas.

## Funcionalidades

* **Respostas em Linguagem Natural:** Entende e responde perguntas sobre a FURIA CS2 (elenco, jogos, resultados, notícias, informações sobre jogadores/staff).
* **Múltiplas Fontes de Dados:** Integra informações de:
    * HLTV (via biblioteca `hltv` e feed RSS)
    * Liquipedia (via scraping da API de parse)
    * RapidAPI (EsportAPI - para dados de partidas)
    * Wikipedia (para informações gerais sobre jogadores, times, eventos)
* **Ferramentas Customizadas (Genkit Tools):** Implementa ferramentas específicas para cada tipo de busca (roster, próximos jogos, resultados, notícias, wiki).
* **Cache Inteligente:** Utiliza Redis (`ioredis`) para cachear resultados de API e buscas, diminuindo a latência e o número de requisições externas. TTLs (Time-To-Live) são configurados para dados e erros.
* **Mecanismos de Fallback e Otimização:**
    * Busca de elenco (roster) tenta HLTV e Liquipedia em paralelo, usando o primeiro resultado válido.
    * Timeouts ajustados para requisições externas.
* **Comandos Rápidos:** Responde a comandos específicos no Telegram para acesso rápido:
    * `/elenco` ou `/roster`: Mostra a escalação atual.
    * `/proximo` ou `/next`: Mostra as próximas partidas (via API Principal).
    * `/ultimo` ou `/last`: Mostra os últimos resultados (via API Principal).
    * `/noticias` ou `/news`: Mostra as últimas notícias do feed RSS da HLTV.
    * `/help`: Mostra comandos disponíveis.
    * `/start`: Mensagem de boas-vindas.
* **Gerenciamento de Histórico:** Salva o histórico recente das conversas no Redis para manter o contexto.
* **Servidor Webhook:** Utiliza Express.js para rodar um servidor web e receber atualizações do Telegram via webhook.
* **Monitoramento e Tracing (Opcional):** Configurado para usar Firebase para tracing e armazenamento de estado do flow Genkit (conforme `genkit.config.ts` e `firebase.json`).

## Tech Stack

* **Linguagem:** TypeScript
* **Runtime:** Node.js (v22 especificada)
* **Framework AI:** Genkit AI
* **Modelo de Linguagem:** Google AI - Gemini Flash
* **Servidor Web:** Express.js
* **Banco de Dados (Cache/Histórico):** Redis (`ioredis`)
* **Cliente Telegram:** `node-telegram-bot-api`
* **Fontes de Dados (Bibliotecas):**
    * `hltv`
    * `wikipedia`
    * `axios` (para APIs REST - RapidAPI, Liquipedia)
    * `cheerio` (para parsing HTML - Liquipedia Scraper)
    * `rss-parser` (para feed de notícias HLTV)
* **Validação:** Zod
* **Variáveis de Ambiente:** `dotenv`
* **Build:** TypeScript Compiler (`tsc`)
* **Linting:** ESLint (configuração Google)

## Pré-requisitos

* Node.js (versão 22 ou compatível, conforme `package.json`)
* NPM (geralmente instalado com Node.js)
* Acesso a uma instância Redis (local ou remota)
* Um Token de Bot do Telegram (obtido via BotFather)
* Uma Chave de API da RapidAPI com assinatura para a [Esport API (esportapi1)](https://rapidapi.com/spi3010/api/esportapi1) (necessário para buscar dados de partidas via API Principal).

## Setup e Instalação

1.  **Clonar o Repositório:**
    ```bash
    git clone <url-do-repositorio>
    cd furia-chat-challenge/functions
    ```
2.  **Instalar Dependências:**
    ```bash
    npm install
    ```
3.  **Configurar Variáveis de Ambiente:**
    * Crie um arquivo chamado `.env` na raiz do diretório `functions`.
    * Adicione as seguintes variáveis ao arquivo `.env`, substituindo pelos seus valores:
        ```dotenv
        # Obrigatório: Token do seu Bot Telegram obtido via BotFather
        TELEGRAM_BOT_TOKEN=SEU_TELEGRAM_BOT_TOKEN

        # Obrigatório: URL de conexão da sua instância Redis
        # Exemplo local: redis://localhost:6379
        # Exemplo remoto: redis://:SENHA@HOST:PORTA
        REDIS_URL=SUA_REDIS_URL

        # Obrigatório: Sua chave da RapidAPI para a EsportAPI
        RAPIDAPI_KEY=SUA_RAPIDAPI_KEY

        # Opcional, mas recomendado (usado no User-Agent para scraping)
        CONTACT_EMAIL=seu-email@example.com
        ```
4.  **Compilar o Código TypeScript:**
    ```bash
    npm run build
    ```
    Isso compilará os arquivos de `src/` para `lib/`.

## Rodando o Bot

1.  **Iniciar o Servidor:**
    ```bash
    npm start
    ```
    O servidor Express será iniciado (por padrão na porta 10000, mas pode ser configurado via variável de ambiente `PORT`) e o bot tentará se conectar ao Redis e validar o token do Telegram. Você verá logs indicando o status da inicialização no console.

2.  **Configurar o Webhook do Telegram:**
    * Para que o Telegram envie mensagens para o seu bot em execução, você precisa registrar o URL do webhook.
    * O URL do webhook será: `https://<SEU_DOMINIO_PUBLICO_OU_IP>:<PORTA>/telegram/webhook/<SEU_TELEGRAM_BOT_TOKEN>`
    * **Importante:** O `<SEU_DOMINIO_PUBLICO_OU_IP>` deve ser acessível publicamente pela internet e, idealmente, usar HTTPS. Se estiver rodando localmente para teste, você pode usar ferramentas como `ngrok` para expor sua porta local publicamente.
    * Você pode registrar o webhook enviando uma requisição GET ou POST para a API do Telegram:
        ```
        [https://api.telegram.org/bot](https://api.telegram.org/bot)<SEU_TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<SEU_DOMINIO_PUBLICO_OU_IP>:<PORTA>/telegram/webhook/<SEU_TELEGRAM_BOT_TOKEN>
        ```
        Substitua os placeholders e acesse essa URL no seu navegador ou use uma ferramenta como `curl`.
    * Para remover o webhook:
        ```
        [https://api.telegram.org/bot](https://api.telegram.org/bot)<SEU_TELEGRAM_BOT_TOKEN>/deleteWebhook
        ```

## Uso

Após configurar o webhook, interaja com o bot no Telegram:

* **Linguagem Natural:** Envie mensagens perguntando sobre:
    * "Qual o time atual da furia?"
    * "Quem são os jogadores da furia?"
    * "Quando é o próximo jogo da furia?"
    * "Quais os últimos resultados da furia?"
    * "Notícias recentes da furia"
    * "Quem é o FalleN?"
* **Comandos:** Use os comandos rápidos:
    * `/elenco` ou `/roster`
    * `/proximo` ou `/next`
    * `/ultimo` ou `/last`
    * `/noticias` ou `/news`
    * `/help`
    * `/start`

## Detalhes Técnicos Adicionais

* **Fontes de Dados e Ferramentas:** O bot usa Genkit Tools para abstrair as chamadas às fontes externas. Cada ferramenta (`getFuriaRoster`, `searchWikipedia`, etc.) encapsula a lógica de busca, tratamento de erros e parsing dos dados.
* **Cache:** O Redis é usado para cachear respostas das ferramentas. Chaves de cache incluem versões (`_v2`, `_v4`, etc.) para facilitar a invalidação quando a lógica muda. TTLs separados são usados para sucessos e erros, com um TTL mais curto para erros, permitindo novas tentativas mais rápidas em caso de falhas temporárias.
* **Paralelismo:** A busca pelo elenco (`getFuriaRoster`) tenta obter dados da HLTV e Liquipedia simultaneamente (`Promise.allSettled`) para reduzir a latência, usando o primeiro resultado bem-sucedido.
* **Prompt Engineering:** Um prompt de sistema detalhado (`systemInstruction`) guia o modelo de linguagem (Gemini Flash) sobre persona, tom de voz, escopo de conhecimento e, crucialmente, sobre a **obrigatoriedade** de usar ferramentas específicas para certos tipos de perguntas, além de como formatar a resposta e lidar com falhas.
* **Logging:** O código inclui logs detalhados (`console.info`, `console.warn`, `console.error`) e medições de tempo (`performance.now`, `console.time`/`timeEnd`) para ajudar na depuração e monitoramento de performance das ferramentas, chamadas de IA e fluxo geral.
* **Estrutura:** O código principal está em `functions/src/index.ts` e é compilado para `functions/lib/index.js`. Arquivos de configuração incluem `package.json`, `tsconfig.json`, `firebase.json`, `firestore.indexes.json`, `genkit.config.ts` (este último não fornecido no contexto, mas inferido pela estrutura Genkit/Firebase).

## Deployment

* O bot é projetado para ser deployado como um serviço web (Node.js/Express).
* Plataformas como Render (indicado pelos logs), Google Cloud Run, Fly.io, etc., são adequadas.
* É essencial configurar corretamente as variáveis de ambiente na plataforma de hospedagem.
* O endpoint do webhook (`/telegram/webhook/<SEU_TOKEN>`) precisa estar acessível publicamente via HTTPS.
* Considere configurar um plano de hospedagem que evite "cold starts" para minimizar a latência inicial das respostas.
