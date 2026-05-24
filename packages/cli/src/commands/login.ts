import { writeAuth } from '../auth-store.js';

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DevicePoll {
  status: 'pending' | 'approved' | 'expired' | 'not_found' | 'consumed';
  access_token?: string;
}

export interface LoginIO {
  fetchImpl?: typeof fetch;
  /** Tick override for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** UI callbacks; default to console + open. */
  onStart?: (start: DeviceStart) => Promise<void> | void;
  /** Limit poll iterations in tests; default ~ start.expires_in / interval. */
  maxPolls?: number;
}

export interface LoginOptions {
  backend: string;
  io?: LoginIO;
}

export interface LoginResult {
  backend: string;
  token: string;
}

/**
 * Run the device-code login flow against the airlock-deploy backend.
 *
 * 1. POST {backend}/auth/device          → device_code + user_code + verification_uri
 * 2. Print verification_uri + user_code  → publisher visits in browser, types code
 * 3. GET  {backend}/auth/device/poll?…   → poll until 'approved'
 * 4. Persist {backend, token} to ~/.airlock-deploy/auth.json (chmod 600)
 */
export async function runLogin(opts: LoginOptions): Promise<LoginResult> {
  const io = opts.io ?? {};
  const fetchFn = io.fetchImpl ?? fetch;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startRes = await fetchFn(`${opts.backend}/auth/device`, { method: 'POST' });
  if (!startRes.ok) throw new Error(`device flow start failed: ${startRes.status}`);
  const start = (await startRes.json()) as DeviceStart;

  if (io.onStart) {
    await io.onStart(start);
  } else {
    console.log(`\nOpen this URL in your browser and paste the code below:\n`);
    console.log(`  ${start.verification_uri}\n`);
    console.log(`  Code: ${start.user_code}\n`);
    console.log(`waiting for approval (expires in ${start.expires_in}s)…`);
  }

  const maxPolls = io.maxPolls ?? Math.ceil(start.expires_in / Math.max(start.interval, 1));
  for (let i = 0; i < maxPolls; i++) {
    await sleep(start.interval * 1000);
    const pollRes = await fetchFn(
      `${opts.backend}/auth/device/poll?device_code=${encodeURIComponent(start.device_code)}`,
    );
    if (!pollRes.ok) throw new Error(`device poll failed: ${pollRes.status}`);
    const poll = (await pollRes.json()) as DevicePoll;
    if (poll.status === 'approved' && poll.access_token) {
      const auth = { backend: opts.backend, token: poll.access_token, saved_at: Date.now() };
      await writeAuth(auth);
      return { backend: opts.backend, token: poll.access_token };
    }
    if (poll.status === 'expired' || poll.status === 'not_found' || poll.status === 'consumed') {
      throw new Error(`device code ${poll.status}`);
    }
    // status === 'pending' → keep polling
  }
  throw new Error('login timed out before approval');
}
