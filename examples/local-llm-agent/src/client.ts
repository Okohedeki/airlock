/**
 * Demo client for examples/local-llm-agent.
 *
 * Without PRIVATE_KEY: makes an unpaid call and prints the 402 + PaymentRequired body.
 * With PRIVATE_KEY:    wraps fetch with @x402/fetch, signs the payment, prints the LLM response.
 *
 * Usage:
 *   pnpm --filter @airlock-deploy/example-local-llm-agent client "hello"
 *   PRIVATE_KEY=0x... pnpm --filter @airlock-deploy/example-local-llm-agent client "hello"
 *
 * Get test USDC for PRIVATE_KEY on Base Sepolia: https://faucet.circle.com/
 */
import { toClientEvmSigner } from '@x402/evm';
import { ExactEvmSchemeV1 } from '@x402/evm/v1';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:3000/chat';
const PROMPT = process.argv[2] ?? 'Say hello in five words or fewer.';
const NETWORK = process.env.PAYMENT_NETWORK ?? 'base-sepolia';

async function main() {
  const messages = [{ role: 'user' as const, content: PROMPT }];
  const body = JSON.stringify({ messages });

  const pk = process.env.PRIVATE_KEY;

  if (!pk) {
    console.log(`unpaid call → ${AGENT_URL}`);
    const res = await fetch(AGENT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    console.log(`status: ${res.status}`);
    const text = await res.text();
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
    if (res.status === 402) {
      console.log('\n(set PRIVATE_KEY=0x... to retry with a signed payment)');
    }
    return;
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  console.log(`paid call → ${AGENT_URL}  signer=${account.address}`);

  const signer = toClientEvmSigner(account);
  const client = new x402Client().registerV1(NETWORK, new ExactEvmSchemeV1(signer));
  const fetchPaid = wrapFetchWithPayment(globalThis.fetch, client);

  const res = await fetchPaid(AGENT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  console.log(`status: ${res.status}`);
  const settlementHeader = res.headers.get('X-PAYMENT-RESPONSE');
  if (settlementHeader) {
    const settlement = decodePaymentResponseHeader(settlementHeader);
    console.log(
      `settlement: tx=${settlement.transaction ?? '(none)'} payer=${settlement.payer ?? '(none)'}`,
    );
  }
  const data = (await res.json()) as { message?: { content?: string }; tokens?: number };
  console.log(`\nresponse:`);
  console.log(data.message?.content ?? JSON.stringify(data));
  if (data.tokens !== undefined) {
    console.log(`\ntokens reported: ${data.tokens}`);
  }
}

main().catch((err) => {
  console.error('client failed:', err);
  process.exitCode = 1;
});
