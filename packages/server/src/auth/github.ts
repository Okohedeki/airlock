/**
 * Tiny GitHub OAuth client — web (Authorization Code) + Device flows.
 *
 * No SDK dependency — calls the documented endpoints directly:
 *   POST https://github.com/login/oauth/access_token      (exchange code)
 *   POST https://github.com/login/device/code             (start device flow)
 *   POST https://github.com/login/oauth/access_token      (poll device)
 *   GET  https://api.github.com/user                      (fetch profile)
 *
 * The Publisher creates an OAuth App at https://github.com/settings/developers
 * (or a GitHub App enabling device flow) and provides:
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 *
 * Tests inject a stub via the `GitHubAuth` interface — production wires the
 * real implementation in `server.ts`.
 */

export interface GitHubProfile {
  id: number;
  login: string;
  avatar_url?: string;
}

export interface DeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DevicePollResult {
  access_token?: string;
  error?: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string;
}

export interface GitHubAuth {
  webAuthorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  fetchProfile(accessToken: string): Promise<GitHubProfile>;
  startDeviceFlow(): Promise<DeviceFlowStart>;
  pollDevice(deviceCode: string): Promise<DevicePollResult>;
}

export class RealGitHubAuth implements GitHubAuth {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private scope = 'read:user',
  ) {}

  webAuthorizeUrl(state: string, redirectUri: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', this.scope);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`github token exchange failed: ${res.status}`);
    const data = (await res.json()) as { access_token?: string; error_description?: string };
    if (!data.access_token) throw new Error(data.error_description ?? 'no access_token returned');
    return data.access_token;
  }

  async fetchProfile(accessToken: string): Promise<GitHubProfile> {
    const res = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`github profile fetch failed: ${res.status}`);
    return (await res.json()) as GitHubProfile;
  }

  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, scope: this.scope }),
    });
    if (!res.ok) throw new Error(`device flow start failed: ${res.status}`);
    return (await res.json()) as DeviceFlowStart;
  }

  async pollDevice(deviceCode: string): Promise<DevicePollResult> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!res.ok) throw new Error(`device poll failed: ${res.status}`);
    return (await res.json()) as DevicePollResult;
  }
}
