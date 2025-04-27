const chatbox = document.getElementById('chatbox');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');

// Novo endpoint: Hosting fará proxy para Function automaticamente
const API_ENDPOINT = '/api/chat';

// Event Listeners
sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        sendMessage();
        event.preventDefault();
    }
});

function addMessageToChatbox(text, type) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', type === 'user' ? 'user-message' : 'bot-message');

    const paragraph = document.createElement('p');
    paragraph.innerHTML = text.replace(/\n/g, '<br>');
    messageElement.appendChild(paragraph);

    chatbox.appendChild(messageElement);
    scrollToBottom();
}

async function sendMessage() {
    const messageText = userInput.value.trim();
    if (!messageText) return;

    addMessageToChatbox(messageText, 'user');
    userInput.value = '';
    userInput.focus();

    const loadingEl = document.createElement('div');
    loadingEl.classList.add('message', 'bot-message', 'loading');
    loadingEl.innerHTML = '<p>Digitando...</p>';
    chatbox.appendChild(loadingEl);
    scrollToBottom();

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: messageText }),
        });

        document.querySelectorAll('.loading').forEach(el => el.remove());

        const data = await response.json();
        if (!response.ok) {
            const err = data?.reply || data?.error || `Erro (${response.status})`;
            addMessageToChatbox(err, 'bot');
            return;
        }

        addMessageToChatbox(data.reply || 'Resposta inesperada.', 'bot');

    } catch (error) {
        document.querySelectorAll('.loading').forEach(el => el.remove());
        const msg = (error instanceof TypeError && error.message.includes('fetch'))
            ? 'Não foi possível conectar. Verifique seu backend.'
            : 'Erro ao processar. Tente novamente.';
        addMessageToChatbox(msg, 'bot');
    }
}

function scrollToBottom() {
    chatbox.scrollTop = chatbox.scrollHeight;
}

userInput.focus();
