/** Minimal HTML rendering for the dashboard. Server-rendered, no framework. */

import type { CliTokenSummary, InspectCall, Project, ProjectStats, User } from './db.js';

const baseStyle = `
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  header { border-bottom: 1px solid #ccc6; padding-bottom: 1rem; margin-bottom: 1.5rem;
           display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 1.2rem; margin: 0; }
  .login { display: inline-flex; align-items: center; gap: 0.5rem; }
  .login img { width: 24px; height: 24px; border-radius: 50%; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #ccc6; }
  th { background: #00000010; font-weight: 600; }
  .empty { padding: 2rem; text-align: center; color: #888; border: 1px dashed #ccc; border-radius: 8px; }
  code { background: #00000010; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
  a.btn { background: #0d6efd; color: white; padding: 0.5rem 1rem; border-radius: 4px;
          text-decoration: none; display: inline-block; }
  a.btn:hover { background: #0b5ed7; }
  .device-code { font-size: 2.5rem; font-family: ui-monospace, monospace; letter-spacing: 0.2rem;
                 padding: 1rem; background: #00000008; border-radius: 8px; text-align: center; }
  form { margin-top: 1rem; }
  input[type=text] { padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; }
  .status-2xx { color: #198754; }
  .status-4xx { color: #fd7e14; }
  .status-5xx { color: #dc3545; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                gap: 1rem; margin: 1.5rem 0; }
  .stat { background: #00000008; padding: 1rem; border-radius: 8px; }
  .stat-label { font-size: 0.85rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.5rem; font-weight: 600; margin-top: 0.25rem; }
  .stat-value-sm { font-size: 0.95rem; margin-top: 0.25rem; }
  .stat-unit { font-size: 0.7em; color: #888; font-weight: 400; }
  nav.primary { display: inline-flex; gap: 1rem; margin-right: 1rem; }
  nav.primary a { color: inherit; text-decoration: none; font-size: 0.95rem; }
  nav.primary a:hover { text-decoration: underline; }
  .danger { background: #dc3545; }
  .danger:hover { background: #b02a37; }
  button.btn { font: inherit; border: none; cursor: pointer; color: white;
               padding: 0.4rem 0.8rem; border-radius: 4px; }
  .body-pre { background: #00000008; padding: 1rem; border-radius: 6px;
              white-space: pre-wrap; word-break: break-word; max-height: 400px;
              overflow: auto; font-size: 0.85rem; }
  .archived-note { background: #fff3cd; color: #664d03; padding: 0.5rem 1rem;
                   border-radius: 4px; margin: 1rem 0; }
  .token-revoked { color: #888; text-decoration: line-through; }
`;

function layout(title: string, user: User | null, csrfToken: string, body: string): string {
  const head = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title} — airlock</title>
<style>${baseStyle}</style></head><body>`;
  const headerHtml = user
    ? `<header><h1>airlock</h1>
       <span class="login">
         <nav class="primary">
           <a href="/projects">Projects</a>
           <a href="/tokens">Tokens</a>
         </nav>
         ${user.avatar_url ? `<img src="${user.avatar_url}" alt="">` : ''}
         <strong>${escHtml(user.github_login)}</strong>
         &middot;
         <form method="POST" action="/auth/logout" style="display:inline;margin:0">
           <input type="hidden" name="_csrf" value="${escHtml(csrfToken)}">
           <button type="submit" style="background:none;border:none;color:#0d6efd;cursor:pointer;padding:0;font:inherit;text-decoration:underline">log out</button>
         </form>
       </span></header>`
    : '<header><h1>airlock</h1></header>';
  return `${head}${headerHtml}<main>${body}</main></body></html>`;
}

export function loginPage(): string {
  return layout(
    'Sign in',
    null,
    '',
    `<h2>Sign in</h2>
     <p>airlock uses your GitHub account to identify your projects.</p>
     <p><a href="/auth/github" class="btn">Continue with GitHub</a></p>`,
  );
}

export function projectsPage(user: User, csrfToken: string, projects: Project[]): string {
  const rows = projects
    .map(
      (p) => `<tr>
        <td><a href="/projects/${p.id}">${escHtml(p.name)}</a></td>
        <td><code>${escHtml(p.target)}</code></td>
        <td>${new Date(p.created_at).toLocaleString()}</td>
      </tr>`,
    )
    .join('');
  const body =
    projects.length === 0
      ? `<div class="empty">
           No projects yet. Run <code>airlock init my-agent --target=fly</code> in a project directory,
           then sync via <code>airlock push</code> (coming soon).
         </div>`
      : `<table><thead><tr><th>Project</th><th>Target</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>`;
  return layout('Projects', user, csrfToken, `<h2>Your projects</h2>${body}`);
}

export function projectDetailPage(
  user: User,
  csrfToken: string,
  project: Project,
  stats: ProjectStats,
  calls: InspectCall[],
): string {
  const rows = calls
    .map((c) => {
      const cls = c.status < 400 ? 'status-2xx' : c.status < 500 ? 'status-4xx' : 'status-5xx';
      return `<tr>
        <td><a href="/projects/${project.id}/calls/${c.id}">${new Date(c.timestamp).toLocaleString()}</a></td>
        <td class="${cls}">${c.status}</td>
        <td><code>${escHtml(c.caller ?? 'anon')}</code></td>
        <td>${c.tokens_used ?? '—'}</td>
        <td>${c.amount_usdc ?? '—'}</td>
        <td>${c.payment_settled ? '✓' : '—'}</td>
      </tr>`;
    })
    .join('');
  const callsBody =
    calls.length === 0
      ? `<div class="empty">No recorded calls yet. The Payment Middleware posts inspect data to <code>POST /api/inspect</code> as calls happen.</div>`
      : `<table><thead><tr><th>Time</th><th>Status</th><th>Caller</th><th>Tokens</th><th>USDC</th><th>Paid</th></tr></thead><tbody>${rows}</tbody></table>`;
  const lastCallAt = stats.last_call_at ? new Date(stats.last_call_at).toLocaleString() : 'never';
  const statsBody = `
    <div class="stats-grid">
      <div class="stat"><div class="stat-label">Revenue</div><div class="stat-value">${escHtml(stats.total_revenue_usdc)} <span class="stat-unit">USDC</span></div></div>
      <div class="stat"><div class="stat-label">Paid calls</div><div class="stat-value">${stats.paid_calls} <span class="stat-unit">/ ${stats.total_calls}</span></div></div>
      <div class="stat"><div class="stat-label">Unique callers</div><div class="stat-value">${stats.unique_callers}</div></div>
      <div class="stat"><div class="stat-label">Tokens served</div><div class="stat-value">${stats.total_tokens.toLocaleString()}</div></div>
      <div class="stat"><div class="stat-label">Last call</div><div class="stat-value-sm">${escHtml(lastCallAt)}</div></div>
    </div>
  `;
  const archivedBanner = project.archived_at
    ? `<div class="archived-note">This project is archived (on ${new Date(project.archived_at).toLocaleString()}). Run <code>airlock sync</code> to un-archive it.</div>`
    : '';
  const dangerZone = project.archived_at
    ? ''
    : `<hr style="margin-top:3rem">
       <h3>Danger zone</h3>
       <p>Archiving hides this project from the dashboard list. Historical calls and stats stay accessible via direct URL. Running <code>airlock sync</code> again revives it.</p>
       <form method="POST" action="/projects/${project.id}/delete"
             onsubmit="return confirm('Archive ${escAttr(project.name)}? Historical data stays. You can revive with sync.');">
         <input type="hidden" name="_csrf" value="${escHtml(csrfToken)}">
         <button type="submit" class="btn danger">Archive project</button>
       </form>`;
  return layout(
    project.name,
    user,
    csrfToken,
    `<p><a href="/projects">← back to projects</a></p>
     <h2>${escHtml(project.name)}</h2>
     <p>Target: <code>${escHtml(project.target)}</code></p>
     ${archivedBanner}
     ${statsBody}
     <h3>Recent calls</h3>
     ${callsBody}
     ${dangerZone}`,
  );
}

export function callDetailPage(
  user: User,
  csrfToken: string,
  project: Project,
  call: InspectCall,
): string {
  const cls = call.status < 400 ? 'status-2xx' : call.status < 500 ? 'status-4xx' : 'status-5xx';
  const requestBody = call.request_body ?? '(empty)';
  const responseBody = call.response_body ?? '(empty)';
  return layout(
    `Call ${call.id} — ${project.name}`,
    user,
    csrfToken,
    `<p><a href="/projects/${project.id}">← back to ${escHtml(project.name)}</a></p>
     <h2>Call ${call.id}</h2>
     <div class="stats-grid">
       <div class="stat"><div class="stat-label">Time</div><div class="stat-value-sm">${escHtml(new Date(call.timestamp).toLocaleString())}</div></div>
       <div class="stat"><div class="stat-label">Status</div><div class="stat-value ${cls}">${call.status}</div></div>
       <div class="stat"><div class="stat-label">Caller</div><div class="stat-value-sm"><code>${escHtml(call.caller ?? 'anon')}</code></div></div>
       <div class="stat"><div class="stat-label">Tokens</div><div class="stat-value">${call.tokens_used ?? '—'}</div></div>
       <div class="stat"><div class="stat-label">USDC</div><div class="stat-value">${escHtml(call.amount_usdc ?? '—')}</div></div>
       <div class="stat"><div class="stat-label">Settled</div><div class="stat-value">${call.payment_settled ? '✓' : '—'}</div></div>
     </div>
     <p>Request URL: <code>${escHtml(call.request_url)}</code></p>
     <h3>Request body</h3>
     <pre class="body-pre">${escHtml(requestBody)}</pre>
     <h3>Response body</h3>
     <pre class="body-pre">${escHtml(responseBody)}</pre>`,
  );
}

export function tokensPage(user: User, csrfToken: string, tokens: CliTokenSummary[]): string {
  const rows = tokens
    .map((t) => {
      const status = t.revoked_at
        ? `<span class="token-revoked">revoked ${new Date(t.revoked_at).toLocaleString()}</span>`
        : 'active';
      const lastUsed = t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'never';
      const revokeBtn = t.revoked_at
        ? '—'
        : `<form method="POST" action="/tokens/${t.id}/revoke" style="margin:0"
             onsubmit="return confirm('Revoke this token? Any CLI using it will get 401 on the next request.');">
             <input type="hidden" name="_csrf" value="${escHtml(csrfToken)}">
             <button type="submit" class="btn danger">Revoke</button>
           </form>`;
      return `<tr>
        <td><code>${escHtml(t.token_prefix)}…</code></td>
        <td>${escHtml(t.label ?? '—')}</td>
        <td>${escHtml(new Date(t.created_at).toLocaleString())}</td>
        <td>${escHtml(lastUsed)}</td>
        <td>${status}</td>
        <td>${revokeBtn}</td>
      </tr>`;
    })
    .join('');
  const body =
    tokens.length === 0
      ? `<div class="empty">No CLI tokens yet. Run <code>airlock login</code> on a machine to mint one.</div>`
      : `<table><thead><tr><th>Token</th><th>Label</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  return layout(
    'CLI tokens',
    user,
    csrfToken,
    `<h2>CLI tokens</h2>
     <p>Each <code>airlock login</code> mints a token tied to this account. Revoke any you don't recognize.</p>
     ${body}`,
  );
}

export function deviceApprovePage(
  user: User | null,
  csrfToken: string,
  error?: string,
  success?: string,
): string {
  if (success) {
    return layout(
      'Device authorization',
      user,
      csrfToken,
      `<h2>${success}</h2><p>You can close this tab and return to your terminal.</p>`,
    );
  }
  return layout(
    'Device authorization',
    user,
    csrfToken,
    `<h2>Authorize CLI device</h2>
     <p>Paste the code your CLI displayed:</p>
     ${error ? `<p style="color: #dc3545">${escHtml(error)}</p>` : ''}
     <form method="POST" action="/auth/device/approve">
       <input type="hidden" name="_csrf" value="${escHtml(csrfToken)}">
       <input type="text" name="user_code" placeholder="XXXX-XXXX" required autofocus>
       <button class="btn" type="submit">Authorize</button>
     </form>`,
  );
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Escape a string for inclusion inside an HTML attribute's single-quoted JS
 * snippet (e.g. onsubmit="return confirm('...')"). The browser unescapes the
 * outer attribute *then* parses the JS, so escHtml's &#39; would round-trip
 * back to ' and break the JS string. Strip single quotes and backslashes.
 */
function escAttr(s: string): string {
  return escHtml(s.replace(/[\\']/g, ''));
}
