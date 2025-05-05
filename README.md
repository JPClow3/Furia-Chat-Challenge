# FURIOSO - Chatbot Inteligente da FURIA CS2 🐾🔥

## Descrição

**FURIOSO** é um chatbot para Telegram especializado e apaixonado pela **FURIA Esports**, focado em fornecer informações atualizadas sobre a equipe de Counter-Strike 2 (CS2). Criado como parte de um desafio e estudo do framework Genkit AI, ele combina o poder do modelo Gemini 1.5 Flash do Google AI para conversação natural com um robusto sistema de ferramentas customizadas para buscar dados precisos em tempo real.

O principal diferencial do FURIOSO é sua capacidade de consultar **múltiplas fontes de dados** (HLTV, Liquipedia, RapidAPI, Feeds de Notícias, Wikipedia) e utilizar **mecanismos de fallback inteligentes** para garantir a melhor informação disponível, além de um sistema de **cache com Redis** para respostas rápidas e eficientes.

## Funcionalidades Principais

* **Conversação Natural e Contextual:** Entende perguntas complexas em português do Brasil sobre a FURIA CS2 e mantém o contexto da conversa (utilizando histórico via Redis) para respostas mais coesas e relevantes.
* **Persona Engajada:** Responde com entusiasmo e paixão pela FURIA, utilizando emojis e uma linguagem amigável, conforme definido no prompt do sistema.
* **Busca de Elenco (Roster):** Obtém a escalação atual (jogadores, coach, status) consultando HLTV e Liquipedia em paralelo para maior resiliência.
* **Informações de Partidas (Próximas e Resultados):**
    * Busca dados de partidas na **RapidAPI (EsportAPI)** como fonte principal.
    * Utiliza **scraping da Liquipedia** como fallback automático caso a API principal falhe ou não retorne dados.
* **Agregador de Notícias:** Monitora múltiplos feeds RSS de fontes relevantes (HLTV, DotEsports, GlobalEsportsNews) e filtra/apresenta as notícias mais recentes sobre a FURIA.
* **Consulta à Wikipedia:** Busca resumos na Wikipedia sobre jogadores, staff, times, eventos ou termos específicos relacionados ao CS2 mencionados na conversa.
* **Ferramentas Customizadas (Genkit Tools):** Implementa ferramentas dedicadas para cada tipo de busca (`getFuriaRoster`, `getFuriaUpcomingMatchesRapidAPI`, `getFuriaRecentResultsRapidAPI`, `getFuriaUpcomingMatchesLiquipedia`, `getFuriaRecentResultsLiquipedia`, `getFuriaNews`, `searchWikipedia`), garantindo modularidade e controle.
* **Cache Inteligente com Redis:** Armazena resultados de buscas bem-sucedidas e erros temporários com TTLs (Time-To-Live) configuráveis, otimizando drasticamente a velocidade de resposta e reduzindo custos/limites de APIs externas.
* **Comandos Rápidos no Telegram:** Oferece comandos para acesso direto a informações chave:
    * `/elenco` ou `/roster`: Escalação atual.
    * `/proximo` ou `/next`: Próximas partidas (via API Principal/Fallback).
    * `/ultimo` ou `/last`: Últimos resultados (via API Principal/Fallback).
    * `/noticias` ou `/news`: Últimas notícias agregadas.
    * `/help` ou `/start`: Ajuda e boas-vindas.
* **Formatação Markdown:** Formata as respostas (especialmente dos comandos) usando Markdown para melhor legibilidade no Telegram (listas, negrito, links).
* **Monitoramento e Tracing (Firebase):** Configurado (`genkit.config.ts`) para integração opcional com Firebase para tracing de execuções do flow Genkit, armazenamento de estado e métricas, auxiliando na depuração e análise de performance.

## Tech Stack & APIs

* **Linguagem:** TypeScript
* **Runtime:** Node.js (v22 especificada no `package.json`)
* **Framework AI:** Google Genkit (`genkit`, `@genkit-ai/core`, `@genkit-ai/flow`)
* **Modelo de Linguagem:** Google AI - Gemini 1.5 Flash (`@genkit-ai/googleai`)
* **Servidor Web:** Express.js
* **Cache & Histórico:** Redis (`ioredis`)
* **Cliente Telegram:** `node-telegram-bot-api`
* **Fontes de Dados (Bibliotecas):**
    * `hltv` (para dados específicos da HLTV)
    * `wikipedia` (para busca na Wikipedia)
    * `axios` (para APIs REST - RapidAPI, Liquipedia Parse API)
    * `cheerio` (para parsing HTML - Liquipedia Scraper Fallback)
    * `rss-parser` (para feeds de notícias)
* **Validação de Dados:** Zod
* **Variáveis de Ambiente:** `dotenv`
* **Build:** TypeScript Compiler (`tsc`)
* **Linting:** ESLint (configuração Google)
* **APIs Externas Utilizadas:**
    * Telegram Bot API
    * Redis (instância local ou remota)
    * RapidAPI (requer assinatura ativa na [Esport API (esportapi1)](https://rapidapi.com/spi3010/api/esportapi1))
    * HLTV (biblioteca e feed RSS público)
    * Liquipedia (Parse API e scraping do site público)
    * Wikipedia API (pública)
    * Google AI API (Gemini)
    * Firebase (opcional, para tracing/métricas/estado via `@genkit-ai/firebase`)

## Pré-requisitos

Antes de começar, garanta que você possui:

1.  **Node.js:** Versão 22 ou superior instalada.
2.  **NPM:** Gerenciador de pacotes Node.js (geralmente instalado com o Node).
3.  **Acesso à Internet:** Conexão estável para buscar dependências e conectar às APIs externas.
4.  **Instância Redis:** Acesso a um servidor Redis (localmente ou um serviço na nuvem como Redis Cloud, Upstash, etc.). Você precisará da URL de conexão.
5.  **Token de Bot do Telegram:** Crie um bot no Telegram falando com o [@BotFather](https://t.me/BotFather) e obtenha o token HTTP API.
6.  **Chave da RapidAPI:** Crie uma conta na [RapidAPI](https://rapidapi.com/), procure pela API "Esport API" (identificada como `esportapi1`) e assine um plano (pode haver um plano gratuito limitado). Obtenha sua `X-RapidAPI-Key`.
7.  **Projeto Google Cloud com Firebase (Opcional):** Se desejar utilizar o tracing, métricas e armazenamento de estado do Genkit via Firebase, você precisará de um projeto no Google Cloud com os serviços Firebase (Firestore) ativados e configurados.
8.  **Git:** Para clonar o repositório.

## Estrutura do Projeto

O código principal do bot reside no diretório `functions/`:

## Estrutura do Projeto

A estrutura principal do projeto é a seguinte:

```text
furia-chat-challenge/
  functions/
    src/
      index.ts       # Código principal: Lógica do Bot, Genkit Flow, Ferramentas, Express API
    lib/               # Código JavaScript compilado (gerado pelo build)
    .env               # Arquivo para variáveis de ambiente (NÃO versionar!)
    package.json       # Dependências e scripts NPM
    tsconfig.json      # Configurações do TypeScript
    ...                # Outros arquivos de configuração (ESLint, etc.)
  firebase.json          # Configurações do Firebase (deploy, emuladores)
  genkit.config.ts       # Configuração dos plugins Genkit (AI, Firebase)
  README.md              # O arquivo de documentação
```
## Setup e Instalação

1.  **Clonar o Repositório:**
    ```bash
    git clone [https://github.com/JPClow3/Furia-Chat-Challenge.git](https://github.com/JPClow3/Furia-Chat-Challenge.git)
    cd Furia-Chat-Challenge/functions
    ```
    *(Note que o código principal está no subdiretório `functions`)*

2.  **Instalar Dependências:**
    ```bash
    npm install
    ```

3.  **Configurar Variáveis de Ambiente:**
    * Crie um arquivo chamado `.env` dentro do diretório `functions`.
    * Adicione as seguintes variáveis, substituindo pelos seus valores:

        ```dotenv
        # Obrigatório: Token do seu Bot Telegram obtido via BotFather
        TELEGRAM_BOT_TOKEN=SEU_TELEGRAM_BOT_TOKEN

        # Obrigatório: URL de conexão da sua instância Redis
        # Exemplo local: redis://localhost:6379
        # Exemplo remoto: redis://:SENHA_SE_TIVER@HOST:PORTA
        REDIS_URL=SUA_REDIS_URL

        # Obrigatório: Sua chave da RapidAPI para a EsportAPI (esportapi1)
        RAPIDAPI_KEY=SUA_RAPIDAPI_KEY

        # Opcional, mas recomendado (usado no User-Agent para scraping/APIs)
        CONTACT_EMAIL=seu-email@provedor.com

        # Opcional: Porta para o servidor Express rodar localmente (padrão: 10000)
        # PORT=10000
        ```

4.  **Verificar Variáveis (Opcional):** Antes de rodar, você pode verificar se as variáveis foram carregadas (o `index.ts` imprime um status básico no início).

5.  **Compilar o Código TypeScript:**
    ```bash
    npm run build
    ```
    Isso compilará os arquivos de `functions/src/` para `functions/lib/`.

## Rodando o Bot

### Modo de Produção Simples:

1.  **Iniciar o Servidor:**
    ```bash
    npm start
    ```
    O servidor Express será iniciado na porta definida (padrão 10000). Logs no console indicarão o status da conexão com Redis, registro das ferramentas Genkit e se o servidor está escutando.

### Modo de Desenvolvimento (com Hot-Reload):

1.  **Terminal 1: Compilar em Modo Watch:**
    ```bash
    npm run build:watch
    ```
    Isso recompilará automaticamente os arquivos em `lib/` sempre que houver alterações em `src/`.

2.  **Terminal 2: Rodar o Servidor (com reinício automático):**
    Você pode usar uma ferramenta como `nodemon` para reiniciar o servidor automaticamente após a recompilação:
    ```bash
    # Instalar nodemon (se não tiver): npm install -g nodemon
    nodemon lib/index.js
    ```
    Ou simplesmente reiniciar `npm start` manualmente após cada `build`.

### Configurando o Webhook do Telegram

Para que o Telegram envie as mensagens do seu chat para o bot em execução, você precisa registrar um **Webhook**:

1.  **Expor seu Bot Publicamente:** O servidor rodando (localmente ou deployado) precisa ter um **URL público acessível via HTTPS**.
    * **Para Testes Locais:** Use uma ferramenta como o `ngrok`. Exemplo: se seu bot roda na porta `10000`, execute `ngrok http 10000`. O ngrok fornecerá um URL público `https://<id-aleatorio>.ngrok.io`.
    * **Para Deploy:** Sua plataforma de hospedagem fornecerá um URL público HTTPS.
2.  **Construir o URL do Webhook:** O URL completo será:
    `https://<SEU_DOMINIO_PUBLICO_HTTPS>/telegram/webhook/<SEU_TELEGRAM_BOT_TOKEN>`
3.  **Registrar o Webhook:** Use seu navegador ou uma ferramenta como `curl` para acessar a seguinte URL da API do Telegram, substituindo os placeholders:
    `https://api.telegram.org/bot<SEU_TELEGRAM_BOT_TOKEN>/setWebhook?url=<URL_DO_WEBHOOK_CONSTRUIDO_NO_PASSO_2>`
    * **Exemplo com ngrok:** `https://api.telegram.org/botSEU_TOKEN/setWebhook?url=https://<id-aleatorio>.ngrok.io/telegram/webhook/SEU_TOKEN`
4.  **Verificar o Webhook:** Você pode verificar se o webhook foi configurado corretamente acessando:
    `https://api.telegram.org/bot<SEU_TELEGRAM_BOT_TOKEN>/getWebhookInfo`
5.  **Remover o Webhook (se necessário):**
    `https://api.telegram.org/bot<SEU_TELEGRAM_BOT_TOKEN>/deleteWebhook`

**Importante:** Sempre que o seu URL público mudar (ao reiniciar o `ngrok` ou fazer um novo deploy), você **PRECISA** registrar o webhook novamente no Telegram com o novo URL.

## Uso

Após configurar o webhook, converse com seu bot no Telegram:

* **Linguagem Natural:** Envie perguntas como:
    * "Qual a escalação atual da Furia?"
    * "Quem saiu da Furia recentemente?"
    * "Quando a Furia joga de novo?"
    * "Contra quem foi o último jogo da Furia e qual foi o placar?"
    * "Me mostra as últimas notícias da Furia sobre o YEKINDAR"
    * "Quem é o guerri?" (Usará Wikipedia)
    * "O que aconteceu no jogo contra a G2?"
    * "A Furia vai jogar a IEM Cologne?"
* **Comandos Rápidos:** Use os comandos para respostas diretas:
    * `/elenco` ou `/roster`
    * `/proximo` ou `/next`
    * `/ultimo` ou `/last`
    * `/noticias` ou `/news`
    * `/help` ou `/start`

**Comportamento Esperado:**

* O bot usará o Gemini para interpretar sua mensagem.
* Se necessário, ele ativará as ferramentas apropriadas (Roster, Partidas, Notícias, Wiki) para buscar dados atualizados.
* Os resultados das ferramentas são cacheados no Redis para agilidade.
* A IA formulará uma resposta em português, no tom FURIOSO, integrando os dados obtidos e o histórico da conversa.
* Em caso de falha ao buscar dados (API offline, etc.), o bot informará que não conseguiu a informação no momento e poderá sugerir verificar fontes oficiais, como: "Putz, não achei essa info aqui agora! 😥 Dá uma conferida no HLTV ou nas redes da FURIA pra ter certeza 😉".

## Detalhes da Implementação

* **Prompt Engineering:** O coração do comportamento da IA reside no `systemInstruction` dentro de `index.ts`. Ele define a persona, o tom, o escopo, e crucialmente, instrui a IA sobre **QUANDO e COMO usar CADA ferramenta**, além de proibir metalinguagem ("usei a ferramenta X") e guiar a síntese dos dados.
* **Cache Estratégico:**
    * Chaves de cache no Redis são versionadas (ex: `roster_hltv_v2`) para facilitar a invalidação ao alterar a lógica.
    * TTLs (Time-To-Live) são definidos separadamente para sucessos (mais longos) e erros (mais curtos), permitindo novas tentativas rápidas em caso de falhas temporárias de APIs.
    * O cache é fundamental para performance e para respeitar limites de uso de APIs gratuitas/pagas.
* **Tratamento de Erros e Fallbacks:**
    * As funções `execute*` das ferramentas contêm blocos `try/catch` para capturar erros de API, parsing ou timeouts.
    * Erros são registrados e, em alguns casos (como partidas), acionam a tentativa de fontes de dados alternativas (Liquipedia se RapidAPI falhar).
    * Erros ou respostas "não encontrado" das ferramentas são passados de volta para a IA, que é instruída (via prompt) sobre como comunicar isso ao usuário de forma amigável.
* **Paralelismo:** A busca de elenco (`executeGetFuriaRoster`) usa `Promise.allSettled` para consultar HLTV e Liquipedia simultaneamente, usando o primeiro resultado bem-sucedido para otimizar o tempo de resposta. A busca de notícias também usa `Promise.allSettled` para buscar múltiplos feeds RSS em paralelo.
* **Logging Detalhado:** O código utiliza `console.info`, `warn`, `error` e `time`/`timeEnd` extensivamente para rastrear o fluxo de execução, chamadas de ferramentas, uso de cache e performance, facilitando a depuração.

## Deployment

Este bot foi projetado como um serviço web Node.js/Express e pode ser hospedado em diversas plataformas:

1.  **Firebase Functions (Recomendado pela Configuração Existente):**
    * Certifique-se de ter `firebase-tools` instalado (`npm install -g firebase-tools`) e estar logado (`firebase login`).
    * Configure as variáveis de ambiente no Google Cloud Functions:
        ```bash
        firebase functions:config:set telegram.token="SEU_TOKEN" redis.url="SUA_URL" rapidapi.key="SUA_CHAVE" contact.email="SEU_EMAIL"
        ```
        *(Adapte os nomes das chaves (`telegram.token`, etc.) se necessário, conforme a forma como você acessa `process.env` no seu código para essas configurações do Firebase)*
    * Faça o deploy:
        ```bash
        firebase deploy --only functions
        ```
    * O Firebase fornecerá um URL HTTPS para sua função. **Use este URL para configurar o webhook do Telegram.**

2.  **Google Cloud Run:**
    * Crie um `Dockerfile` para containerizar sua aplicação (Node.js + Express). Exemplo básico:
        ```dockerfile
        FROM node:22-slim
        WORKDIR /usr/src/app
        COPY functions/package*.json ./
        RUN npm install --only=production
        COPY functions/lib ./lib
        COPY functions/.env ./.env # Copie se for usar .env diretamente no container, OU configure variáveis de ambiente no Cloud Run
        ENV PORT=8080 # Cloud Run espera a porta 8080 por padrão
        EXPOSE 8080
        CMD [ "node", "lib/index.js" ]
        ```
        *(Lembre-se de rodar `npm run build` antes de construir a imagem para ter o diretório `lib`)*
    * Faça o build da imagem e envie para o Google Container Registry (GCR) ou Artifact Registry.
    * Crie um serviço no Cloud Run usando a imagem.
    * Configure as **variáveis de ambiente** necessárias diretamente nas configurações do serviço Cloud Run (método preferido em vez de copiar o `.env`).
    * O Cloud Run fornecerá um URL HTTPS. **Use este URL para configurar o webhook.**

3.  **Render / Fly.io / Outras Plataformas PaaS:**
    * Siga a documentação da plataforma específica para deploy de aplicações Node.js/Express.
    * Geralmente, você conectará seu repositório Git e a plataforma cuidará do build (`npm install`, `npm run build`) e da execução (`npm start`). Certifique-se que o `start` script no `package.json` está correto (`node lib/index.js`).
    * Configure as **variáveis de ambiente** através do painel de controle ou CLI da plataforma.
    * A plataforma fornecerá um URL HTTPS. **Use este URL para configurar o webhook.**

**Considerações Importantes para Deploy:**

* **Variáveis de Ambiente:** NUNCA comite seu arquivo `.env`! Configure as variáveis de ambiente diretamente na sua plataforma de hospedagem. É a prática mais segura.
* **Webhook:** Após o deploy, **SEMPRE atualize o webhook do Telegram** para apontar para o novo URL HTTPS da sua aplicação. Verifique com `/getWebhookInfo`.
* **Cold Starts:** Em plataformas serverless (Functions, Cloud Run), pode haver "cold starts" (demora na primeira resposta após inatividade). Considere configurar instâncias mínimas (se disponível/custo permitir) para mitigar isso se a latência inicial for crítica.
* **Segurança:** Revise as opções de segurança da sua plataforma de hospedagem. Idealmente, apenas o Telegram deveria poder acessar seu endpoint de webhook.

---

Divirta-se interagindo com o FURIOSO! #GoFURIA
