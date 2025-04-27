// Apenas os imports realmente necessários para os plugins usados abaixo
import {googleAI} from '@genkit-ai/googleai';
import {firebase} from '@genkit-ai/firebase';

export default {
    plugins: [
        googleAI(), // Plugin do Google AI (Gemini)
        firebase(), // Plugin do Firebase (Tracing, etc.)
    ],
    flowStateStore: 'firebase',
    traceStore: 'firebase',
    cacheStore: 'firebase', // Ou 'noop' se não quiser cache por enquanto
    logLevel: 'debug',
    enableTracingAndMetrics: true,
};