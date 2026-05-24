import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../config-file.js';
import { buildServeApp } from './serve.js';

let cwd: string;
let oldHome: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-cli-serve-'));
  oldHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), 'airlock-cli-serve-home-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  if (process.env.HOME) await rm(process.env.HOME, { recursive: true, force: true });
  process.env.HOME = oldHome;
});

describe('buildServeApp', () => {
  it('forwards /v1/chat/completions to the upstream and surfaces tokens via header', async () => {
    await writeConfig(cwd, {
      project: { name: 'my-llm', target: 'fly', schemaVersion: 1 },
      payment: {
        enabled: false,
        wallet: '0x1234567890abcdef1234567890abcdef12345678',
        mode: 'flat',
        priceUsdc: '0.001',
      },
    });

    const upstreamCalls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          id: 'cmpl-xxx',
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const { app } = await buildServeApp({
      cwd,
      upstream: 'http://localhost:9999',
      port: 0,
      fetchImpl,
    });

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.url).toBe('http://localhost:9999/v1/chat/completions');
    expect(res.body.usage.total_tokens).toBe(12);
    expect(res.headers['x-tokens-used']).toBe('12');
  });

  it('returns 402 with x402 PaymentRequired when payment is enabled and no header given', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const { app } = await buildServeApp({
      cwd,
      upstream: 'http://localhost:9999',
      port: 0,
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      priceUsdc: '0.001',
      fetchImpl,
    });

    const res = await request(app).post('/v1/chat/completions').send({ messages: [] });

    expect(res.status).toBe(402);
    expect(res.body.x402Version).toBe(1);
    expect(res.body.accepts[0]?.network).toBe('base-sepolia');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exposes /chat as an alias for /v1/chat/completions', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [], usage: { total_tokens: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const { app } = await buildServeApp({
      cwd,
      upstream: 'http://localhost:9999',
      port: 0,
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      noPayment: true,
      fetchImpl,
    });

    const res = await request(app).post('/chat').send({ messages: [] });
    expect(res.status).toBe(200);
  });

  it('forwards stream:true requests as a real SSE stream with usage parsed for billing', async () => {
    await writeConfig(cwd, {
      project: { name: 'my-llm', target: 'fly', schemaVersion: 1 },
      payment: {
        enabled: false,
        wallet: '0x1234567890abcdef1234567890abcdef12345678',
        mode: 'flat',
        priceUsdc: '0.001',
      },
    });

    let capturedBody: { stream?: boolean; stream_options?: object } | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      const chunks = [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ];
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const { app } = await buildServeApp({
      cwd,
      upstream: 'http://localhost:9999',
      port: 0,
      fetchImpl,
    });

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hi' }], stream: true });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"total_tokens":5');
    expect(res.text).toContain('[DONE]');
    // serve.ts forces stream_options.include_usage so per-token billing works
    expect(capturedBody?.stream).toBe(true);
    expect((capturedBody?.stream_options as { include_usage?: boolean })?.include_usage).toBe(true);
  });

  it('throws when no config and no --wallet/--price flags', async () => {
    await expect(
      buildServeApp({ cwd, upstream: 'http://localhost:9999', port: 0 }),
    ).rejects.toThrow(/config\.toml|init|wallet|price/);
  });

  it('configures the reporter when AIRLOCK_TOKEN + projectName + backend are set', async () => {
    await writeConfig(cwd, {
      project: { name: 'my-llm', target: 'fly', schemaVersion: 1 },
      payment: {
        enabled: false,
        wallet: '0x1234567890abcdef1234567890abcdef12345678',
        mode: 'flat',
        priceUsdc: '0.001',
      },
    });
    process.env.AIRLOCK_TOKEN = 'tok-xxx';
    process.env.AIRLOCK_BACKEND = 'http://backend.test';
    try {
      const { reporter } = await buildServeApp({
        cwd,
        upstream: 'http://localhost:9999',
        port: 0,
      });
      expect(reporter).toEqual({
        url: 'http://backend.test',
        token: 'tok-xxx',
        projectName: 'my-llm',
      });
    } finally {
      process.env.AIRLOCK_TOKEN = undefined;
      process.env.AIRLOCK_BACKEND = undefined;
    }
  });
});
