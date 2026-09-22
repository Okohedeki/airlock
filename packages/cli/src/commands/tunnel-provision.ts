/**
 * `airlock tunnel provision` — zero-interaction durable Cloudflare tunnel (epic 09).
 *
 * Give it a Cloudflare **API token** (Account → Cloudflare Tunnel:Edit + Zone → DNS:Edit)
 * and a hostname; it creates (or reuses) a named tunnel, points its ingress at your local
 * port, creates the DNS CNAME, and writes the connector token to `.env` as
 * AIRLOCK_CF_TUNNEL_TOKEN. Then `airlock up --durable --hostname <h>` runs it (no sudo,
 * no dashboard, no browser). CI-friendly.
 *
 * Inputs (flags or env): CF_API_TOKEN (or AIRLOCK_CF_API_TOKEN), --hostname, --port,
 * optional --account / CF_ACCOUNT_ID, optional --name.
 */


const API = 'https://api.cloudflare.com/client/v4';

export interface ProvisionOptions {
  apiToken: string;
  hostname: string;
  port: number;
  accountId?: string;
  /** Zone id. If given, the token needs NO Zone:Read (only DNS:Edit + Tunnel:Edit). */
  zoneId?: string;
  name?: string;
  fetchImpl?: typeof fetch;
}

export interface ProvisionResult {
  tunnelId: string;
  token: string;
  hostname: string;
  accountId: string;
  zoneId: string;
  cname: string;
}

async function cf(
  fetchFn: typeof fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; result: any; errors?: unknown };
  if (!json.success) {
    throw new Error(`Cloudflare API ${method} ${path} failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

/** The registrable zone for a hostname = the longest zone name that is its suffix. */
export function pickZone(hostname: string, zones: Array<{ id: string; name: string }>): { id: string; name: string } {
  const match = zones
    .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!match) {
    throw new Error(
      `no Cloudflare zone found for ${hostname} (have: ${zones.map((z) => z.name).join(', ') || 'none'}). ` +
        'The API token must have DNS:Edit on the zone that owns this hostname.',
    );
  }
  return match;
}

/** Ingress config that routes the hostname to the local worker port (remotely-managed). */
export function ingressConfig(hostname: string, port: number): unknown {
  return {
    config: {
      ingress: [
        { hostname, service: `http://localhost:${port}` },
        { service: 'http_status:404' },
      ],
    },
  };
}

export async function provisionTunnel(opts: ProvisionOptions): Promise<ProvisionResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const token = opts.apiToken;
  const name = opts.name ?? `airlock-${opts.hostname.split('.')[0]}`;

  const accountId = opts.accountId ?? (await cf(fetchFn, token, 'GET', '/accounts'))?.[0]?.id;
  if (!accountId) throw new Error('could not resolve a Cloudflare account id (set --account / CF_ACCOUNT_ID).');

  // Zone for the hostname. If a zone id is supplied, skip the GET /zones lookup so the
  // token needs no Zone:Read — only DNS:Edit + Cloudflare Tunnel:Edit.
  const zone = opts.zoneId
    ? { id: opts.zoneId, name: opts.hostname }
    : pickZone(opts.hostname, await cf(fetchFn, token, 'GET', '/zones?per_page=50'));

  // Find-or-create the named tunnel; fetch its connector token.
  const existing = await cf(fetchFn, token, 'GET',
    `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
  let tunnelId: string;
  let connectorToken: string;
  if (existing && existing.length) {
    tunnelId = existing[0].id;
    connectorToken = await cf(fetchFn, token, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
  } else {
    const created = await cf(fetchFn, token, 'POST', `/accounts/${accountId}/cfd_tunnel`,
      { name, config_src: 'cloudflare' });
    tunnelId = created.id;
    connectorToken = created.token ??
      (await cf(fetchFn, token, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`));
  }

  // Route ingress (hostname → local port) on the remotely-managed tunnel.
  await cf(fetchFn, token, 'PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    ingressConfig(opts.hostname, opts.port));

  // Upsert the DNS CNAME → <tunnelId>.cfargotunnel.com (proxied).
  const cname = `${tunnelId}.cfargotunnel.com`;
  const records = await cf(fetchFn, token, 'GET',
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(opts.hostname)}`);
  const rec = { type: 'CNAME', name: opts.hostname, content: cname, proxied: true };
  if (records && records.length) {
    await cf(fetchFn, token, 'PUT', `/zones/${zone.id}/dns_records/${records[0].id}`, rec);
  } else {
    await cf(fetchFn, token, 'POST', `/zones/${zone.id}/dns_records`, rec);
  }

  return { tunnelId, token: connectorToken, hostname: opts.hostname, accountId, zoneId: zone.id, cname };
}
