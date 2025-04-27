const chatbox = document.getElementById('chatbox');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');

// IMPORTANTE: URL do Emulador da Cloud Function
// Verifique se o ID do projeto (furia-chat-challenge), região (us-central1)
// e nome da função (api) estão corretos.
const API_ENDPOINT = 'http://127.0.0.1:5001/furia-chat-challenge/us-central1/api/chat';

// --- Event Listeners ---
sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', function (event) {
    // Envia a mensagem se a tecla Enter for pressionada
    if (event.key === 'Enter') {
        sendMessage();
    }
});

// --- Funções ---

/**
 * Adiciona uma mensagem (usuário ou bot) à caixa de chat.
 * @param {string} text O texto da mensagem.
 * @param {string} type 'user' ou 'bot'.
 */
function addMessageToChatbox(text, type) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', type === 'user' ? 'user-message' : 'bot-message');

    const paragraph = document.createElement('p');
    paragraph.textContent = text; // Exibe o texto diretamente
    messageElement.appendChild(paragraph);

    chatbox.appendChild(messageElement);

    // Rola para o final da chatbox para mostrar a nova mensagem
    chatbox.scrollTop = chatbox.scrollHeight;
}

/**
 * Pega a mensagem do usuário, envia para a API e exibe a resposta.
 */
async function sendMessage() {
    const messageText = userInput.value.trim();

    if (!messageText) {
        return; // Não envia mensagens vazias
    }

    // 1. Exibe a mensagem do usuário na chatbox
    addMessageToChatbox(messageText, 'user');
    userInput.value = ''; // Limpa o campo de input

    // (Opcional) Mostra um feedback de "carregando"
    const loadingElement = document.createElement('div');
    loadingElement.classList.add('message', 'bot-message', 'loading');
    loadingElement.innerHTML = '<p>Digitando...</p>';
    chatbox.appendChild(loadingElement);
    chatbox.scrollTop = chatbox.scrollHeight;

    try {
        // 2. Envia a mensagem para a API backend
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({message: messageText}), // Envia no formato esperado pelo backend
        });

        // Remove o feedback de "carregando"
        chatbox.removeChild(loadingElement);

        // Espera o corpo da resposta ser lido como JSON
        const data = await response.json();

        if (!response.ok) {
            // Se a resposta não for OK (ex: erro 400, 500), mostra o erro vindo do JSON
            console.error("Erro da API:", data);
            // Usa data.reply se existir (como no erro 500 que ajustamos), senão usa data.error ou um fallback
            addMessageToChatbox(data.reply || data.error || `Ocorreu um erro na comunicação com o servidor (${response.status}).`, 'bot');
            return;
        }

        // 3. Recebe a resposta da API e exibe na chatbox
        if (data && data.reply) {
            // A resposta JSON da API contém a chave 'reply' com o texto do bot
            addMessageToChatbox(data.reply, 'bot');
        } else {
            addMessageToChatbox("Recebi uma resposta inesperada do servidor.", 'bot');
        }

    } catch (error) {
        // Remove o feedback de "carregando" se ainda existir
        if (chatbox.contains(loadingElement)) {
            chatbox.removeChild(loadingElement);
        }
        console.error('Erro ao enviar mensagem:', error);
        addMessageToChatbox('Não foi possível conectar ao assistente. Verifique sua conexão ou tente novamente mais tarde.', 'bot');
    }
}

// Mensagem inicial do bot (já está no HTML)