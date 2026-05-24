/**
 * agent-template — a model-free reference agent you fork and ship.
 *
 * It does real work (fetch a web page, extract its title + word count) and
 * mounts the airlock payment middleware IN-PROCESS on its own route. There is
 * no separate proxy and no model requirement: the LLM is an *optional*
 * dependency (set OPENAI_API_KEY to also get a summary). This is the canonical
 * shape for "deploy an agentic process to a paid web URL".
 */
import { withPaymentExpress } from '@airlockhq/payment-fly-node';
import express from 'express';
import {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  paymentConfig,
  PORT,
} from './config.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    name: 'agent-template',
    payment: { enabled: paymentConfig.enabled, mode: paymentConfig.mode },
    model: OPENAI_API_KEY ? OPENAI_MODEL : 'disabled (set OPENAI_API_KEY to enable summaries)',
    docs: 'POST /run with {"url":"https://example.com"}',
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post(
  '/run',
  withPaymentExpress(paymentConfig, async (req) => {
    const body = req.body as { url?: string } | undefined;
    if (!body?.url) {
      return { status: 400, body: { error: 'url required' } };
    }

    let pageText: string;
    try {
      const pageRes = await fetch(body.url, { redirect: 'follow' });
      if (!pageRes.ok) {
        return { status: 502, body: { error: `fetch failed (${pageRes.status})` } };
      }
      pageText = await pageRes.text();
    } catch (err) {
      return { status: 502, body: { error: `fetch error: ${(err as Error).message}` } };
    }

    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(pageText)?.[1]?.trim() ?? null;
    const visible = pageText
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    const words = visible.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    const summary = OPENAI_API_KEY ? await summarize(words.slice(0, 1500).join(' ')) : null;

    // Report billable units (here: words read). per_token mode bills on this;
    // flat mode ignores it. This is the harness-agnostic usage callback.
    return {
      status: 200,
      body: { url: body.url, title, wordCount, summary },
      usage: { units: wordCount, unitLabel: 'words' },
    };
  }),
);

async function summarize(text: string): Promise<string | null> {
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'Summarize the page in one sentence.' },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`agent-template listening on http://localhost:${PORT}`);
  console.log(`  endpoint: POST /run  {"url":"https://example.com"}`);
  console.log(
    `  payment:  ${paymentConfig.enabled ? `ON (${paymentConfig.mode})` : 'OFF (set PAYMENT_ENABLED=1 to enable)'}`,
  );
  console.log('\n  expose publicly with:  airlock dev -p ' + PORT);
});
