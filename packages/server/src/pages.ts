/** Minimal HTML rendering for the dashboard. Server-rendered, no framework. */

import type { InspectCall, Project, User } from './db.js';

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
`;

function layout(title: string, user: User | null, body: string): string {
  const head = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title} — airlock-deploy</title>
<style>${baseStyle}</style></head><body>`;
  const headerHtml = user
    ? `<header><h1>airlock-deploy</h1>
       <span class="login">
         ${user.avatar_url ? `<img src="${user.avatar_url}" alt="">` : ''}
         <strong>${escHtml(user.github_login)}</strong>
         &middot; <a href="/auth/logout">log out</a>
       </span></header>`
    : '<header><h1>airlock-deploy</h1></header>';
  return `${head}${headerHtml}<main>${body}</main></body></html>`;
}

export function loginPage(): string {
  return layout(
    'Sign in',
    null,
    `<h2>Sign in</h2>
     <p>airlock-deploy uses your GitHub account to identify your projects.</p>
     <p><a href="/auth/github" class="btn">Continue with GitHub</a></p>`,
  );
}

export function projectsPage(user: User, projects: Project[]): string {
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
           No projects yet. Run <code>airlock-deploy init my-agent --target=fly</code> in a project directory,
           then sync via <code>airlock-deploy push</code> (coming soon).
         </div>`
      : `<table><thead><tr><th>Project</th><th>Target</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>`;
  return layout('Projects', user, `<h2>Your projects</h2>${body}`);
}

export function projectDetailPage(user: User, project: Project, calls: InspectCall[]): string {
  const rows = calls
    .map((c) => {
      const cls = c.status < 400 ? 'status-2xx' : c.status < 500 ? 'status-4xx' : 'status-5xx';
      return `<tr>
        <td>${new Date(c.timestamp).toLocaleString()}</td>
        <td class="${cls}">${c.status}</td>
        <td><code>${escHtml(c.caller ?? 'anon')}</code></td>
        <td>${c.tokens_used ?? '—'}</td>
        <td>${c.payment_settled ? '✓' : '—'}</td>
      </tr>`;
    })
    .join('');
  const body =
    calls.length === 0
      ? `<div class="empty">No recorded calls yet. The Payment Middleware posts inspect data to <code>POST /api/inspect</code> as calls happen.</div>`
      : `<table><thead><tr><th>Time</th><th>Status</th><th>Caller</th><th>Tokens</th><th>Paid</th></tr></thead><tbody>${rows}</tbody></table>`;
  return layout(
    project.name,
    user,
    `<p><a href="/projects">← back to projects</a></p>
     <h2>${escHtml(project.name)}</h2>
     <p>Target: <code>${escHtml(project.target)}</code></p>
     ${body}`,
  );
}

export function deviceApprovePage(user: User | null, error?: string, success?: string): string {
  if (success) {
    return layout(
      'Device authorization',
      user,
      `<h2>${success}</h2><p>You can close this tab and return to your terminal.</p>`,
    );
  }
  return layout(
    'Device authorization',
    user,
    `<h2>Authorize CLI device</h2>
     <p>Paste the code your CLI displayed:</p>
     ${error ? `<p style="color: #dc3545">${escHtml(error)}</p>` : ''}
     <form method="POST" action="/auth/device/approve">
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
