const chatbox = document.getElementById('chatbox');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');

// IMPORTANTE: URL do Emulador da Cloud Function
// Verifique se o ID do projeto (furia-chat-challenge), região (us-central1)
// e nome da função (api) estão corretos.
const API_ENDPOINT = 'http://127.0.0.1:5001/furia-chat-challenge/us-central1/api/chat';

// --- Event Listeners ---
sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', function(event) {
    // Envia a mensagem se a tecla Enter for pressionada
    if (event.key === 'Enter') {
        sendMessage();
        // Prevent default form submission if inside a form
        event.preventDefault();
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
    // Render Markdown safely - VERY basic example, consider a library like Marked or Showdown for full support
    // This example just replaces \n with <br> which is safe but limited.
    paragraph.innerHTML = text.replace(/\n/g, '<br>');
    messageElement.appendChild(paragraph);

    chatbox.appendChild(messageElement);

    // Rola para o final da chatbox para mostrar a nova mensagem
    scrollToBottom();
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
    userInput.focus(); // Refocus input after sending

    // 2. (Opcional) Mostra um feedback de "carregando"
    const loadingElement = document.createElement('div');
    loadingElement.classList.add('message', 'bot-message', 'loading');
    loadingElement.innerHTML = '<p>Digitando...</p>';
    chatbox.appendChild(loadingElement);
    scrollToBottom();


    try {
        // 3. Envia a mensagem para a API backend
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: messageText }), // Envia no formato esperado pelo backend
        });

        // Remove o feedback de "carregando" - needs reference outside try? No, should be ok.
        const loadingIndicators = chatbox.querySelectorAll('.loading');
        loadingIndicators.forEach(el => el.remove());


        // Espera o corpo da resposta ser lido como JSON
        const data = await response.json(); // Throws on invalid JSON

        if (!response.ok) {
            // Se a resposta não for OK (ex: erro 400, 500), mostra o erro vindo do JSON
            console.error("Erro da API:", response.status, data);
            // Use data.reply if it exists and contains an error message from the backend
            const errorMsg = data?.reply || data?.error || `Ocorreu um erro (${response.status}). Tente novamente.`;
            addMessageToChatbox(errorMsg, 'bot');
            return;
        }

        // 4. Recebe a resposta da API e exibe na chatbox
        if (data && data.reply) {
            addMessageToChatbox(data.reply, 'bot');
        } else {
            console.warn("Resposta inesperada da API:", data);
            addMessageToChatbox("Recebi uma resposta inesperada do servidor.", 'bot');
        }

    } catch (error) {
        // Remove o feedback de "carregando" se ainda existir
        const loadingIndicators = chatbox.querySelectorAll('.loading');
        loadingIndicators.forEach(el => el.remove());

        console.error('Erro ao enviar mensagem:', error);
        // Check if it's a network error (TypeError: Failed to fetch often indicates network/CORS issues)
        if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
            addMessageToChatbox('Não foi possível conectar ao assistente. Verifique sua conexão ou se o servidor está rodando.', 'bot');
        } else {
            addMessageToChatbox('Ocorreu um erro ao processar sua mensagem. Tente novamente mais tarde.', 'bot');
        }
    }
}

/**
 * Rola a chatbox para o final.
 */
function scrollToBottom() {
    chatbox.scrollTop = chatbox.scrollHeight;
}

// Adiciona foco inicial ao campo de input quando a página carrega
userInput.focus();