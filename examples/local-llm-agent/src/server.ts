import { withPaymentExpress } from '@airlockhq/payment-fly-node';
import express from 'express';
import { MODEL, OLLAMA_URL, PORT, paymentConfig } from './config.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: false;
}

interface OllamaChatResponse {
  model: string;
  message: ChatMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    name: 'local-llm-agent',
    model: MODEL,
    ollama: OLLAMA_URL,
    payment: { enabled: paymentConfig.enabled, mode: paymentConfig.mode },
    docs: 'POST /chat with {"messages":[{"role":"user","content":"..."}]}',
  });
});

app.post(
  '/chat',
  withPaymentExpress(paymentConfig, async (req) => {
    const body = req.body as { messages?: ChatMessage[]; model?: string } | undefined;
    if (!body?.messages?.length) {
      return { status: 400, body: { error: 'messages[] required' } };
    }

    const ollamaReq: OllamaChatRequest = {
      model: body.model ?? MODEL,
      messages: body.messages,
      stream: false,
    };

    const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ollamaReq),
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      return {
        status: 502,
        body: { error: 'ollama upstream failed', status: ollamaRes.status, detail: text },
      };
    }

    const data = (await ollamaRes.json()) as OllamaChatResponse;
    const tokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);

    return {
      status: 200,
      headers: { 'X-Tokens-Used': String(tokens) },
      body: {
        model: data.model,
        message: data.message,
        tokens,
      },
    };
  }),
);

app.listen(PORT, () => {
  console.log(`local-llm-agent listening on http://localhost:${PORT}`);
  console.log(`  model:   ${MODEL}`);
  console.log(`  ollama:  ${OLLAMA_URL}`);
  console.log(
    `  payment: ${paymentConfig.enabled ? `ON (${paymentConfig.mode})` : 'OFF (set PAYMENT_ENABLED=1 to enable)'}`,
  );
});
