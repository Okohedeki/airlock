/* airlock Control Plane — enterprise dashboard client (vanilla, hash-routed). */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const j = async (u, o) => { const r = await fetch(u, o); return r.json().catch(() => ({})); };
const num = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n, d = 0) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const ago = (m) => m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd';
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 1600); }

let ENV = 'all';
let WORKERS = [];
const SECTIONS = { overview: 'Overview', workers: 'Workers', models: 'Models', runs: 'Runs', approvals: 'Approvals', tenants: 'Tenants', cost: 'Cost & usage', audit: 'Audit log', access: 'Access control' };
const envClass = (e) => e === 'prod' ? 'prod' : e === 'staging' ? 'staging' : 'dev';
const envScoped = (rows) => ENV === 'all' ? rows : rows.filter((r) => (r.env || 'dev') === ENV);

/* ---- RBAC (client mirror of server ROLE_PERMS; the server enforces, this just gates UI) ---- */
const ROLE_PERMS = {
  owner: ['*'], operator: ['*:read', 'workers:start', 'workers:stop', 'workers:config', 'control:write', 'exposure:write', 'versions:write', 'approvals:decide', 'env:write'],
  approver: ['*:read', 'approvals:decide'], auditor: ['*:read', 'audit:read'], viewer: ['overview:read', 'workers:read', 'runs:read'],
};
let ME = null;
const CAN = (perm) => {
  const ps = ROLE_PERMS[(ME && ME.role) || 'viewer'] || [];
  return ps.some((p) => p === '*' || p === perm || (p.endsWith(':*') && perm.startsWith(p.slice(0, -1))) || (p === '*:read' && perm.endsWith(':read')));
};
/* fetch that bounces to login on 401 and toasts on 403 */
async function api(u, o) {
  const r = await fetch(u, o);
  if (r.status === 401) { ME = null; renderLogin(); throw new Error('unauth'); }
  if (r.status === 403) { const e = await r.json().catch(() => ({})); toast(e.error || 'forbidden'); throw new Error('forbidden'); }
  return r;
}

/* ---- inline charts (no deps) ---- */
function spark(data, h = 130, stroke = 'var(--brand)') {
  if (!data || !data.length) return '';
  const w = 600, vs = data.map((d) => d.v), mx = Math.max(...vs, 1), mn = Math.min(...vs, 0);
  const x = (i) => (i / (data.length - 1)) * w, y = (v) => h - 8 - ((v - mn) / (mx - mn || 1)) * (h - 20);
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');
  const area = `0,${h} ` + pts + ` ${w},${h}`;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${stroke}" stop-opacity=".18"/><stop offset="1" stop-color="${stroke}" stop-opacity="0"/></linearGradient></defs>
    <polygon class="area" points="${area}"/><polyline class="ln" points="${pts}" style="stroke:${stroke}"/></svg>`;
}
function bars(data, h = 120) {
  const mx = Math.max(...data.map((d) => d.v), 1);
  return `<div class="bars" style="height:${h}px">${data.map((d) => `<div class="bar" style="height:${Math.max(2, (d.v / mx) * 100)}%" title="${num(d.v)}"></div>`).join('')}</div>`;
}

/* ---- routing ---- */
function go() {
  const route = (location.hash.replace('#/', '').split('/')[0]) || 'overview';
  document.querySelectorAll('.rail a.nav').forEach((a) => a.classList.toggle('on', a.dataset.route === route));
  $('#bcrumb').innerHTML = `airlock <span class="x">›</span> ${esc(SECTIONS[route] || route)}`;
  (RENDER[route] || RENDER.overview)();
}
window.addEventListener('hashchange', go);
document.querySelectorAll('.rail a.nav').forEach((a) => a.onclick = () => { location.hash = '#/' + a.dataset.route; });

/* ---- login ---- */
async function renderLogin() {
  document.querySelector('.app').style.display = 'none';
  let ov = $('#loginOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'loginOverlay'; document.body.appendChild(ov); }
  const d = await (await fetch('/api/login-users')).json();
  ov.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:var(--bg);z-index:200;';
  ov.innerHTML = `<div style="width:380px;max-width:92vw;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden">
    <div style="padding:22px 22px 6px;display:flex;align-items:center;gap:10px"><span style="width:30px;height:30px;border-radius:7px;background:var(--brand);color:#04201c;display:grid;place-items:center;font-weight:900">▲</span>
      <div><div style="font-weight:800;font-size:16px">airlock Control Plane</div><div class="mut" style="font-size:12px">sign in to operate the fleet</div></div></div>
    <div style="padding:14px 22px 22px">
      ${d.sso && d.sso.enforced
        ? `<button class="btn p" style="width:100%;justify-content:center" onclick="toast('SSO enforced — configure an OIDC issuer to complete sign-in')">Sign in with ${esc(d.sso.provider)}</button>
           <div class="mut" style="font-size:11px;margin-top:10px">SSO is enforced; local sign-in is disabled.</div>`
        : `<div class="mut" style="font-size:11px;margin-bottom:8px">Choose an identity (roles demonstrate RBAC enforcement):</div>
           ${(d.users || []).map((u) => `<button class="btn" style="width:100%;justify-content:space-between;margin-bottom:6px" onclick="doLogin('${esc(u.email)}')"><span><b>${esc(u.name)}</b> <span class="mut" style="font-weight:400">${esc(u.email)}</span></span><span class="rolechip">${esc(u.role)}</span></button>`).join('')}`}
    </div></div>`;
}
window.doLogin = async (email) => {
  const r = await (await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json();
  if (!r.ok) return toast(r.error || 'sign-in failed');
  const ov = $('#loginOverlay'); if (ov) ov.remove();
  document.querySelector('.app').style.display = '';
  boot();
};

/* ---- header / env ---- */
async function boot() {
  const me = await (await fetch('/api/me')).json();
  ME = me.user; // no login wall — the server defaults to the Owner; identity is switchable below
  if (!ME) return renderLogin();
  $('#acctName').textContent = ME.name;
  $('#acctAv').textContent = ME.name.split(' ').map((p) => p[0]).join('').slice(0, 2);
  $('#acctRole').textContent = ME.role; $('#acctOrg').textContent = 'Acme Corp · ' + ME.email;
  $('.acct').onclick = accountMenu;
  const env = await j('/api/environments');
  $('#envSel').innerHTML = '<option value="all">All environments</option>' +
    (env.environments || []).map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join('');
  $('#envSel').onchange = (e) => { ENV = e.target.value; $('#envDot').className = 'envdot ' + (ENV === 'all' ? '' : envClass(ENV)); go(); };
  go();
  setInterval(() => { if (!$('#scrim').classList.contains('on') && (location.hash.includes('overview') || location.hash.includes('workers') || location.hash === '' )) refreshCounts(); }, 6000);
}
function accountMenu() {
  let m = $('#acctMenu'); if (m) { m.remove(); return; }
  m = document.createElement('div'); m.id = 'acctMenu';
  m.style.cssText = 'position:fixed;top:48px;right:14px;background:var(--surface);border:1px solid var(--line2);border-radius:10px;box-shadow:0 8px 30px rgba(20,23,28,.18);z-index:80;min-width:200px;padding:6px;';
  m.innerHTML = `<div class="mut" style="font-size:10.5px;padding:6px 10px;text-transform:uppercase;letter-spacing:.06em">Signed in as ${esc(ME.role)}</div>
    <button class="btn ghost" style="width:100%;justify-content:flex-start" onclick="signout()">Sign out</button>
    <div class="mut" style="font-size:10.5px;padding:8px 10px 2px;text-transform:uppercase;letter-spacing:.06em">Demo · switch identity</div>
    <div id="switchList" style="max-height:200px;overflow:auto"></div>`;
  document.body.appendChild(m);
  fetch('/api/login-users').then((r) => r.json()).then((d) => {
    $('#switchList').innerHTML = (d.users || []).map((u) => `<button class="btn ghost" style="width:100%;justify-content:space-between" onclick="switchUser('${esc(u.email)}')"><span>${esc(u.name.split(' ')[0])}</span><span class="rolechip">${esc(u.role)}</span></button>`).join('');
  });
  setTimeout(() => document.addEventListener('click', function h(e) { if (!m.contains(e.target) && !$('.acct').contains(e.target)) { m.remove(); document.removeEventListener('click', h); } }), 0);
}
window.signout = async () => { await fetch('/api/logout', { method: 'POST' }); const m = $('#acctMenu'); if (m) m.remove(); boot(); toast('reset to Owner'); };
window.switchUser = async (email) => { await fetch('/api/logout', { method: 'POST' }); const m = $('#acctMenu'); if (m) m.remove(); doLogin(email); };
async function refreshCounts() {
  const w = await j('/api/workers'); WORKERS = w.workers || []; $('#wsPath').textContent = (w.root || '').split('/').slice(-1)[0];
  $('#ctWorkers').textContent = WORKERS.length;
  const a = await j('/api/approvals'); $('#ctApprovals').textContent = (a.held || []).length || '';
}

/* ============================ SECTIONS ============================ */
const RENDER = {};

RENDER.overview = async () => {
  const d = await j('/api/overview'); const k = d.kpi || {};
  const tile = (key, v, sub, cls) => `<div class="kpi"><div class="k">${key}</div><div class="v">${v}</div>${sub ? `<div class="d ${cls || ''}">${sub}</div>` : ''}</div>`;
  const noRuns = !(k.runs24h);
  $('#page').innerHTML = `
  <div class="ph"><h1>Fleet overview</h1><span class="sub">live posture across this workspace</span></div>
  <div class="grid kpis" style="margin-bottom:14px">
    ${tile('Workers live', `${k.workersLive}<small>/${k.workersTotal}</small>`)}
    ${tile('Runs', num(k.runs24h))}
    ${tile('Error rate', (k.errorRatePct || 0) + '%', 'SLO 2.0%', k.errorRatePct > 2 ? 'down' : '')}
    ${tile('Tokens', num(k.tokens24h))}
    ${tile('Spend', money(k.spend24h, 2))}
    ${tile('Approvals', k.pendingApprovals, k.pendingApprovals ? 'awaiting human' : '', k.pendingApprovals ? 'down' : '')}
  </div>
  <div class="grid cols3" style="margin-bottom:14px">
    <div class="card"><div class="h"><h3>Run volume · 24h</h3><span class="sp"></span><span class="hint">runs/hr</span></div><div class="b">${noRuns ? '<div class="empty">no runs yet — start a worker and send traffic</div>' : spark(d.runVolume)}</div></div>
    <div class="card"><div class="h"><h3>Active alerts</h3></div><div>${(d.alerts || []).length ? d.alerts.map((a) => `<div class="alert"><span class="sev ${a.sev}">${a.sev}</span><div><b>${esc(a.worker)}</b> — ${esc(a.msg)}</div><span class="sp"></span><span class="env ${envClass(a.env)}">${esc(a.env)}</span></div>`).join('') : '<div class="empty">no active alerts</div>'}</div></div>
  </div>
  <div class="card" style="margin-bottom:14px"><div class="h"><h3>Spend · 24h</h3><span class="sp"></span><span class="hint">$ / hr</span></div><div class="b">${noRuns ? '<div class="empty">no spend yet</div>' : spark(d.cost, 130, 'var(--prod)')}</div></div>
  <div class="card"><div class="h"><h3>Top tenants by usage</h3></div>
    <table><thead><tr><th>Tenant</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>
    ${(d.topTenants || []).length ? d.topTenants.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td class="num">${num(t.runs24h)}</td><td class="num">${num(t.tokens24h)}</td><td class="num">${money(t.costMtd, 2)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">no tenant traffic yet</td></tr>'}
    </tbody></table></div>`;
  refreshCounts();
};

RENDER.workers = async () => {
  const d = await j('/api/workers'); WORKERS = d.workers || []; $('#wsPath').textContent = (d.root || '').split('/').slice(-1)[0];
  const rows = envScoped(WORKERS);
  $('#page').innerHTML = `
  <div class="ph"><h1>Workers</h1><span class="sub">${rows.length} workers in this workspace</span><span class="sp"></span></div>
  <div class="card">
    <div class="toolbar">
      <input id="wf" placeholder="Filter by name…" style="min-width:200px">
      <select id="wfStatus"><option value="">All status</option><option>running</option><option>error</option><option>idle</option></select>
      <select id="wfExpose"><option value="">All exposure</option><option>public</option><option>internal</option></select>
      <span class="sp"></span><span class="hint mut" style="font-family:var(--mono);font-size:11px">metrics are live from each worker's runtime</span>
    </div>
    <table><thead><tr><th>Worker</th><th>Env</th><th>Status</th><th>Harness</th><th>Version</th><th>Expose</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Err%</th><th class="num">Cost</th><th></th></tr></thead>
    <tbody id="wkBody"></tbody></table>
  </div>`;
  const draw = () => {
    const q = ($('#wf').value || '').toLowerCase(), st = $('#wfStatus').value, ex = $('#wfExpose').value;
    const f = rows.filter((w) => (!q || w.name.toLowerCase().includes(q)) && (!st || (w.health === st || w.status === st)) && (!ex || w.expose === ex));
    $('#wkBody').innerHTML = f.length ? f.map((w) => {
      const status = w.status === 'running' ? 'running' : (w.health || w.status);
      return `<tr>
        <td><span class="nm" data-id="${esc(w.id)}">${esc(w.name)}</span> ${w.status === 'running' ? '<span class="live-chip">live</span>' : ''}</td>
        <td><span class="env ${envClass(w.env)}">${esc(w.env)}</span></td>
        <td><span class="st"><span class="dot ${w.status === 'running' ? 'running live' : (w.health || w.status)}"></span>${esc(status)}</span></td>
        <td class="mono">${esc(w.harness)}</td><td class="mono">${esc(w.version)}</td>
        <td><span class="tag ${w.expose}">${esc(w.expose)}</span></td>
        <td class="num">${num(w.runs || 0)}</td><td class="num">${num(w.tokens || 0)}</td><td class="num">${w.errPct || 0}</td><td class="num">${money(w.cost || 0, 2)}</td>
        <td style="text-align:right">${w.status === 'running'
          ? (CAN('workers:stop') ? `<button class="btn sm no" data-act="stop" data-id="${esc(w.id)}">Stop</button>` : '<span class="mut" style="font-size:11px">running</span>')
          : (CAN('workers:start') ? `<button class="btn sm p" data-act="start" data-id="${esc(w.id)}">Start</button>` : '<span class="mut" style="font-size:11px">—</span>')}</td></tr>`;
    }).join('') : '<tr><td colspan="11" class="empty">no worker.yaml found under the workspace.</td></tr>';
    $('#wkBody').querySelectorAll('.nm').forEach((n) => n.onclick = () => openWorker(n.dataset.id));
    $('#wkBody').querySelectorAll('button[data-act]').forEach((b) => b.onclick = () => act(b.dataset.id, b.dataset.act, b));
  };
  ['wf', 'wfStatus', 'wfExpose'].forEach((id) => $('#' + id).oninput = draw);
  draw();
};
async function act(id, action, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await api(`/api/workers/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast('worker ' + (action === 'start' ? 'started' : 'stopped'));
  } catch (e) { /* api() already toasted/redirected */ }
  RENDER.workers();
}

RENDER.models = async () => {
  const d = await j('/api/models'); const m = d.models || [];
  $('#page').innerHTML = `<div class="ph"><h1>Models</h1><span class="sub">model bindings declared across every worker.yaml — open a worker to set them up</span></div>
  <div class="card"><table><thead><tr><th>Worker</th><th>Binding</th><th>Model</th><th>Endpoint</th><th>API key env</th><th>Default</th></tr></thead><tbody>
  ${m.length ? m.map((b) => `<tr><td><span class="nm" data-id="${esc(b.workerId)}">${esc(b.worker)}</span></td><td class="mono">${esc(b.name)}</td><td class="mono">${esc(b.model)}</td><td class="mono">${esc(b.endpoint)}</td><td class="mono">${esc(b.env_key)}</td><td>${b.isDefault ? '<span class="bdg ok">default</span>' : ''}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">no model bindings declared. Add a models: block to a worker.yaml, or open a worker → Models.</td></tr>'}
  </tbody></table></div>`;
  $('#page').querySelectorAll('.nm').forEach((n) => n.onclick = () => openWorker(n.dataset.id, 'models'));
};

RENDER.runs = async () => {
  const d = await j('/api/runs'); const rows = d.runs || [];
  $('#page').innerHTML = `
  <div class="ph"><h1>Runs</h1><span class="sub">agent workflow executions across running workers</span></div>
  <div class="card"><div class="toolbar"><input id="rf" placeholder="Filter by worker or tenant…" style="min-width:240px">
    <select id="rfStatus"><option value="">All status</option><option>ok</option><option>blocked</option><option>stopped</option><option>error</option></select><span class="sp"></span></div>
    <table><thead><tr><th>Run</th><th>Worker</th><th>Tenant</th><th>Status</th><th class="num">Steps</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Age</th></tr></thead><tbody id="rnBody"></tbody></table></div>`;
  const draw = () => {
    const q = ($('#rf').value || '').toLowerCase(), st = $('#rfStatus').value;
    const f = rows.filter((r) => (!q || (r.worker + r.tenant).toLowerCase().includes(q)) && (!st || r.status === st));
    $('#rnBody').innerHTML = f.length ? f.map((r) => `<tr><td class="mono">${esc(r.id)} ${r.live ? '<span class="live-chip">live</span>' : ''}</td>
      <td><b>${esc(r.worker)}</b></td><td>${esc(r.tenant)}</td><td><span class="bdg ${r.status}">${esc(r.status)}</span></td>
      <td class="num">${r.steps}</td><td class="num">${num(r.tokens)}</td><td class="num">${money(r.costUsd, 2)}</td><td class="num">${r.ageMins != null ? ago(r.ageMins) : 'live'}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">no runs yet — start a worker and exercise it from the Playground.</td></tr>';
  };
  ['rf', 'rfStatus'].forEach((id) => $('#' + id).oninput = draw); draw();
};

RENDER.approvals = async () => {
  const d = await j('/api/approvals'); const held = d.held || [];
  $('#page').innerHTML = `
  <div class="ph"><h1>Approvals</h1><span class="sub">held agent actions awaiting a human decision</span><span class="sp"></span></div>
  <div class="card"><div class="h"><h3>Holding queue</h3><span class="sp"></span><span class="hint">${held.length} pending</span></div>
  <table><thead><tr><th>Run</th><th>Worker</th><th>Tool</th><th>Arguments</th><th>Env</th><th>Age</th><th style="text-align:right">Decision</th></tr></thead><tbody>
  ${held.length ? held.map((h) => `<tr><td class="mono">${esc(h.run)} ${h.live ? '<span class="live-chip">live</span>' : ''}</td>
    <td><b>${esc(h.worker || '—')}</b></td><td class="mono">${esc(h.tool)}</td>
    <td class="mono" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(JSON.stringify(h.args || {}))}</td>
    <td><span class="env ${envClass(h.env || 'dev')}">${esc(h.env || 'dev')}</span></td><td class="mono">${h.ageMins != null ? ago(h.ageMins) : '—'}</td>
    <td style="text-align:right;white-space:nowrap">${!CAN('approvals:decide')
      ? '<span class="mut" style="font-size:11px">view only</span>'
      : h.live
        ? `<button class="btn sm ok" onclick="decide('${esc(h.workerId)}','${esc(h.run)}','approve')">Approve</button> <button class="btn sm no" onclick="decide('${esc(h.workerId)}','${esc(h.run)}','deny')">Deny</button>`
        : `<button class="btn sm ok" onclick="toast('approved (sample)')">Approve</button> <button class="btn sm no" onclick="toast('denied (sample)')">Deny</button>`}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">nothing holding — guarded tools appear here when a run pauses.</td></tr>'}
  </tbody></table></div>`;
};
window.decide = async (wid, run, decision) => {
  try {
    await api(`/api/workers/${encodeURIComponent(wid)}/proxy/v1/runs/${encodeURIComponent(run)}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
    toast('run ' + decision + 'd');
  } catch (e) { /* handled */ }
  RENDER.approvals();
};

RENDER.tenants = async () => {
  const d = await j('/api/tenants'); const t = d.tenants || [];
  $('#page').innerHTML = `<div class="ph"><h1>Tenants</h1><span class="sub">caller identities declared by workers + their real usage</span></div>
  <div class="card"><table><thead><tr><th>Tenant</th><th>Status</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>
  ${t.length ? t.map((x) => `<tr><td><b>${esc(x.name)}</b></td>
    <td><span class="st"><span class="dot ${x.status}"></span>${esc(x.status)}</span></td>
    <td class="num">${num(x.runs24h)}</td><td class="num">${num(x.tokens24h)}</td><td class="num">${money(x.costMtd, 2)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">no tenants — declare tenancy.keys in a worker.yaml or send traffic.</td></tr>'}
  </tbody></table></div>`;
};

RENDER.cost = async () => {
  const d = await j('/api/cost');
  const total = (d.byEnv || []).reduce((a, e) => a + e.cost, 0);
  const envCost = (e) => (d.byEnv || []).find((x) => x.env === e)?.cost || 0;
  $('#page').innerHTML = `<div class="ph"><h1>Cost &amp; usage</h1><span class="sub">spend metered from real run tokens × each worker's price table</span></div>
  <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
    <div class="kpi"><div class="k">Spend · MTD</div><div class="v">${money(total, 2)}</div></div>
    <div class="kpi"><div class="k">Production</div><div class="v">${money(envCost('prod'), 2)}</div></div>
    <div class="kpi"><div class="k">Staging</div><div class="v">${money(envCost('staging'), 2)}</div></div>
    <div class="kpi"><div class="k">Development</div><div class="v">${money(envCost('dev'), 2)}</div></div>
  </div>
  <div class="card" style="margin-bottom:14px"><div class="h"><h3>Daily spend · 30d</h3><span class="sp"></span><span class="hint">$ / day</span></div><div class="b">${total ? bars(d.series) : '<div class="empty">no spend yet — set a price table (pricing:) in a worker.yaml and run it</div>'}</div></div>
  <div class="card"><div class="h"><h3>Spend by tenant</h3></div><table><thead><tr><th>Tenant</th><th class="num">Runs</th><th class="num">Cost</th><th>Share</th></tr></thead><tbody>
  ${(() => { const ts = d.tenants || []; if (!ts.length) return '<tr><td colspan="4" class="empty">no tenant spend yet</td></tr>'; const mx = Math.max(...ts.map((t) => t.costMtd), 0.0001); return ts.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td class="num">${num(t.runs)}</td><td class="num">${money(t.costMtd, 2)}</td><td style="width:220px"><div class="barwrap"><i style="width:${(t.costMtd / mx) * 100}%"></i></div></td></tr>`).join(''); })()}
  </tbody></table></div>`;
};

RENDER.audit = async () => {
  if (!CAN('audit:read')) { $('#page').innerHTML = `<div class="ph"><h1>Audit log</h1></div><div class="card"><div class="empty">Your role (<b>${esc(ME.role)}</b>) does not have <code>audit:read</code>. Ask an Owner or Auditor for access.</div></div>`; return; }
  const d = await j('/api/audit'); const ev = d.events || [];
  $('#page').innerHTML = `<div class="ph"><h1>Audit log</h1><span class="sub">immutable, append-only record of every privileged action</span><span class="sp"></span><span class="live-chip">persisted</span></div>
  <div class="card"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Env</th><th>Detail</th></tr></thead><tbody>
  ${ev.map((e) => `<tr><td class="mono">${e.tsMins === 0 ? 'just now' : ago(e.tsMins) + ' ago'}</td><td>${esc(e.actor)}</td>
    <td class="mono">${esc(e.action)}</td><td class="mono">${esc(e.target)}</td><td><span class="env ${envClass(e.env)}">${esc(e.env)}</span></td>
    <td class="mut">${esc(e.detail)}</td></tr>`).join('')}
  </tbody></table></div>`;
};

RENDER.access = async () => {
  const d = await j('/api/access'); const sso = d.sso || {};
  $('#page').innerHTML = `<div class="ph"><h1>Access control</h1><span class="sub">identity, roles &amp; environments</span><span class="sp"></span><span class="sample">sample</span></div>
  <div class="grid cols2" style="margin-bottom:14px">
    <div class="card"><div class="h"><h3>Single sign-on</h3><span class="sp"></span><span class="bdg ${sso.enforced ? 'ok' : ''}">${sso.enforced ? 'enforced' : 'optional'}</span></div><div class="b"><div class="kv">
      <div class="k">Provider</div><div class="v">${esc(sso.provider)} · ${esc(sso.protocol)}</div>
      <div class="k">Domain</div><div class="v">${esc(sso.domain)}</div>
      <div class="k">MFA</div><div class="v">${esc(sso.mfa)}</div>
      <div class="k">SCIM provisioning</div><div class="v">${sso.scimProvisioning ? 'enabled' : 'disabled'}</div></div>
      ${CAN('access:write') ? `<div class="srow" style="margin-top:6px"><span class="nm">Enforce SSO</span><span class="sub">blocks local sign-in (needs OIDC issuer)</span><span class="sp"></span><label class="sw"><input type="checkbox" ${sso.enforced ? 'checked' : ''} onchange="setSso(this.checked)"><span class="tr"></span></label></div>` : ''}</div></div>
    <div class="card"><div class="h"><h3>Environments</h3></div><div class="b">${(d.environments || []).map((e) => `<div class="srow"><span class="env ${envClass(e.id)}">${esc(e.label)}</span><span class="sp"></span><span class="sub">${e.id === 'prod' ? 'change control · 2-person approval' : e.id === 'staging' ? 'operators + approvers' : 'all engineers'}</span></div>`).join('')}</div></div>
  </div>
  <div class="card" style="margin-bottom:14px"><div class="h"><h3>Members</h3><span class="sp"></span><span class="hint">${(d.users || []).length} users</span></div>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>SSO</th><th>Last active</th></tr></thead><tbody>
    ${(d.users || []).map((u) => { const role = (d.roles || []).find((r) => r.id === u.role); const roleCell = CAN('access:write')
        ? `<select class="inp" style="width:auto;text-align:left" onchange="setRole('${esc(u.email)}',this.value)">${(d.roles || []).map((r) => `<option value="${esc(r.id)}" ${r.id === u.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>`
        : `<span class="rolechip">${esc(role ? role.label : u.role)}</span>`;
      return `<tr><td><b>${esc(u.name)}</b>${u.email === (ME && ME.email) ? ' <span class="mut" style="font-size:11px">(you)</span>' : ''}</td><td class="mono">${esc(u.email)}</td><td>${roleCell}</td><td>${u.sso ? '✓' : '—'}</td><td class="mut">${ago(u.lastActiveMins)} ago</td></tr>`; }).join('')}
    </tbody></table></div>
  <div class="card"><div class="h"><h3>Roles</h3></div><table><thead><tr><th>Role</th><th>Description</th><th>Permissions</th></tr></thead><tbody>
    ${(d.roles || []).map((r) => `<tr><td><span class="rolechip">${esc(r.label)}</span></td><td>${esc(r.desc)}</td><td class="mono mut">${r.perms.map(esc).join(' · ')}</td></tr>`).join('')}
  </tbody></table></div>`;
};

window.setRole = async (email, role) => { try { await api('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setRole: { email, role } }) }); toast(email.split('@')[0] + ' → ' + role); } catch (e) { /* handled */ } };
window.setSso = async (enforced) => { try { await api('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sso: { enforced } }) }); toast('SSO ' + (enforced ? 'enforced' : 'optional')); } catch (e) { /* handled */ } RENDER.access(); };

/* ============================ WORKER DRAWER ============================ */
let CUR = null, logTimer = null;
window.openWorker = async (id, tab) => {
  const w = WORKERS.find((x) => x.id === id) || (await j('/api/workers/' + encodeURIComponent(id)));
  CUR = w; if (logTimer) { clearInterval(logTimer); logTimer = null; }
  $('#dwName').textContent = w.name;
  $('#dwEnv').className = 'env ' + envClass(w.env); $('#dwEnv').textContent = w.env;
  $('#dwHarness').textContent = w.harness + (w.version ? ' · ' + w.version : '');
  $('#dwDot').className = 'dot ' + (w.status === 'running' ? 'running' : (w.health || w.status));
  const start = (tab || 'overview');
  const tabs = ['Overview', 'Controls', 'Models', 'Versions', 'Exposure', 'Config', 'Logs'];
  $('#dwTabs').innerHTML = tabs.map((t) => `<button data-t="${t.toLowerCase()}" class="${t.toLowerCase() === start ? 'on' : ''}">${t}</button>`).join('');
  $('#dwTabs').querySelectorAll('button').forEach((b) => b.onclick = () => dwTab(b.dataset.t));
  $('#scrim').classList.add('on'); $('#drawer').classList.add('on');
  dwTab(start);
};
function closeDrawer() { $('#scrim').classList.remove('on'); $('#drawer').classList.remove('on'); CUR = null; if (logTimer) { clearInterval(logTimer); logTimer = null; } }
$('#dwClose').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
function dwTab(name) {
  $('#dwTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  ({ overview: dwOverview, controls: dwControls, models: dwModels, versions: dwVersions, exposure: dwExposure, config: dwConfig, logs: dwLogs }[name] || dwOverview)();
}
const live = () => CUR && !CUR.sample;
const notLive = (msg) => `<div class="empty">${msg}</div>`;

function dwOverview() {
  const w = CUR; const m = (sub) => `<div class="kpi"><div class="k">${sub[0]}</div><div class="v">${sub[1]}</div></div>`;
  $('#dwBody').innerHTML = `
  <div class="grid kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
    ${m(['Status', `<span class="st" style="font-size:18px"><span class="dot ${w.status === 'running' ? 'running' : (w.health || w.status)}"></span>${w.status === 'running' ? 'running' : (w.health || w.status)}</span>`])}
    ${m(['Runs', num(w.runs || 0)])}${m(['Tokens', num(w.tokens || 0)])}${m(['Error rate', (w.errPct || 0) + '%'])}${m(['Cost', money(w.cost || 0, 2)])}${m(['Models', w.models || 0])}
  </div>
  <div class="card"><div class="h"><h3>Identity</h3></div><div class="b"><div class="kv">
    <div class="k">Worker</div><div class="v">${esc(w.name)}</div><div class="k">Environment</div><div class="v">${esc(w.env)}</div>
    <div class="k">Harness</div><div class="v">${esc(w.harness)}</div><div class="k">Version</div><div class="v">${esc(w.version)}</div>
    <div class="k">Exposure</div><div class="v">${esc(w.expose)}</div>${w.port ? `<div class="k">Address</div><div class="v">127.0.0.1:${w.port}</div>` : ''}
  </div></div></div>
  <div class="card" style="margin-top:14px"><div class="h"><h3>Environment</h3><span class="sp"></span><span class="hint">change-control</span></div><div class="b">
    <div class="srow"><span class="nm">Assigned environment</span><span class="sp"></span>
      ${CAN('env:write')
        ? `<select class="inp" style="width:auto;text-align:left" onchange="setEnv(this.value)"><option ${w.env === 'dev' ? 'selected' : ''}>dev</option><option ${w.env === 'staging' ? 'selected' : ''}>staging</option><option ${w.env === 'prod' ? 'selected' : ''}>prod</option></select>`
        : `<span class="env ${envClass(w.env)}">${esc(w.env)}</span> <span class="mut" style="font-size:11px;margin-left:8px">role "${esc(ME.role)}" cannot reassign</span>`}</div>
  </div></div>`;
}
window.setEnv = async (env) => { try { await api('/api/workers/' + encodeURIComponent(CUR.id) + '/env', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env }) }); CUR.env = env; toast('environment → ' + env); } catch (e) { /* handled */ } };
async function dwControls() {
  if (!live()) return void ($('#dwBody').innerHTML = notLive('Controls operate a live worker. This is a representative fleet entry — start a local worker to manage skills, model and guards.'));
  if (CUR.status !== 'running') return void ($('#dwBody').innerHTML = notLive('Worker is stopped. Start it from the Workers table to manage its controls live.'));
  const c = await j('/api/workers/' + encodeURIComponent(CUR.id) + '/proxy/v1/control');
  if (!c || !c.controls) return void ($('#dwBody').innerHTML = notLive('control plane unavailable.'));
  const sw = (on, h) => `<label class="sw"><input type="checkbox" ${on ? 'checked' : ''} ${h}><span class="tr"></span></label>`;
  const b = c.controls.budget || {}, appr = new Set(c.controls.approvals || []);
  $('#dwBody').innerHTML = `
  <div class="sectit">Model routing</div>
  <div class="srow"><span class="nm">Active model</span><span class="sp"></span>
    <select class="inp" style="width:auto;text-align:left" onchange="ctl('routing',{default:this.value})">${c.models.bindings.map((x) => `<option ${x.name === c.models.default ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
  <div class="sectit">Skills</div>
  ${c.skills.length ? c.skills.map((s) => `<div class="srow"><span class="nm">${esc(s.id)}</span><span class="sub">→ ${esc(s.tool)}</span><span class="sp"></span>${sw(s.enabled, `onchange="ctlSkill('${esc(s.id)}',this.checked)"`)}</div>`).join('') : '<div class="srow sub">no skills declared.</div>'}
  <div class="sectit">Guards</div>
  <div class="srow"><span class="nm">Max steps</span><span class="sp"></span><input class="inp" type="number" value="${c.controls.max_steps ?? ''}" onchange="ctl('controls',{max_steps:Number(this.value)})"></div>
  <div class="srow"><span class="nm">Budget · tokens</span><span class="sp"></span><input class="inp" type="number" placeholder="none" value="${b.tokens ?? ''}" onchange="ctl('controls',{'budget.tokens':this.value===''?false:Number(this.value)})"></div>
  <div class="sectit">Approvals · hold for a human</div>
  ${(c.tools || []).map((t) => `<div class="srow"><span class="nm">${esc(t)}</span><span class="sp"></span>${sw(appr.has(t), `onchange="ctlAppr('${esc(t)}',this.checked)"`)}</div>`).join('')}`;
  if (!CAN('control:write')) {
    $('#dwBody').querySelectorAll('input,select').forEach((e) => { e.disabled = true; });
    $('#dwBody').insertAdjacentHTML('afterbegin', `<div class="valid" style="background:var(--info-bg);color:#1f6feb;border:1px solid #cfe0fb;margin-bottom:12px">read-only — role "${esc(ME.role)}" cannot change controls</div>`);
  }
}
window.ctl = async (p, body) => { try { await api(`/api/workers/${encodeURIComponent(CUR.id)}/proxy/v1/control/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); toast('applied to next run'); } catch (e) { /* handled */ } dwControls(); };
window.ctlSkill = (id, on) => ctl('skills/' + encodeURIComponent(id), { enabled: on });
window.ctlAppr = (t, on) => ctl('controls', { approval: { tool: t, on } });
async function dwModels() {
  if (!live()) return void ($('#dwBody').innerHTML = notLive('Model setup is available for live workspace workers.'));
  const d = await j('/api/workers/' + encodeURIComponent(CUR.id) + '/model');
  const rw = CAN('workers:config');
  const f = (id, v) => rw ? `<input class="inp" style="width:100%;text-align:left" id="${id}" value="${esc(v)}">` : `<span class="v">${esc(v)}</span>`;
  $('#dwBody').innerHTML = `
    <p class="mut" style="margin:0 0 12px">Set up each model binding — the model name, the OpenAI-compatible endpoint, and the env var holding its API key. Saved to <code>worker.yaml</code>; restart the worker to apply.</p>
    ${(d.bindings || []).map((b) => `<div class="card" style="margin-bottom:10px"><div class="b">
      <div class="srow" style="padding-top:0"><span class="nm">${esc(b.name)}</span> ${b.isDefault ? '<span class="bdg ok">default</span>' : ''}<span class="sp"></span>
        ${rw && !b.isDefault ? `<button class="btn sm" onclick="setDefaultModel('${esc(b.name)}')">Make default</button>` : ''}</div>
      <div class="kv" style="margin-top:6px">
        <div class="k">Model</div><div class="v">${f('m_model_' + b.name, b.model)}</div>
        <div class="k">Endpoint</div><div class="v">${f('m_ep_' + b.name, b.endpoint)}</div>
        <div class="k">API key env</div><div class="v">${f('m_key_' + b.name, b.env_key)}</div>
      </div>
      ${rw ? `<div style="margin-top:10px"><button class="btn p sm" onclick="saveModel('${esc(b.name)}')">Save binding</button></div>` : ''}
    </div></div>`).join('') || '<div class="empty">no model bindings declared in this worker.yaml.</div>'}
    ${rw ? '' : `<div class="valid" style="background:var(--info-bg);color:#1f6feb;border:1px solid #cfe0fb">read-only — role "${esc(ME.role)}" cannot edit models</div>`}`;
}
window.saveModel = async (name) => {
  const g = (p) => document.getElementById(p + name); const v = (p) => g(p) ? g(p).value : undefined;
  try {
    const r = await api('/api/workers/' + encodeURIComponent(CUR.id) + '/model', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, model: v('m_model_'), endpoint: v('m_ep_'), env_key: v('m_key_') }) });
    const d = await r.json(); if (d.ok) { toast('model binding saved'); dwModels(); } else toast((d.errors || ['invalid']).join('; '));
  } catch (e) { /* handled */ }
};
window.setDefaultModel = async (name) => {
  try { const r = await api('/api/workers/' + encodeURIComponent(CUR.id) + '/model', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setDefault: name }) }); if ((await r.json()).ok) { toast('default model → ' + name); dwModels(); } } catch (e) { /* handled */ }
};
function dwVersions() {
  const w = CUR;
  $('#dwBody').innerHTML = `<div class="card"><div class="h"><h3>Versions &amp; rollout</h3><span class="sp"></span><span class="sample">representative</span></div>
    <table><thead><tr><th>Version</th><th>Stage</th><th>Traffic</th><th>Deployed</th><th></th></tr></thead><tbody>
    <tr><td class="mono">${esc(w.version)}</td><td><span class="bdg ok">stable</span></td><td>90%</td><td class="mut">3d ago</td><td style="text-align:right"><button class="btn sm" onclick="toast('promoted (sample)')">Promote</button></td></tr>
    <tr><td class="mono">v${(parseInt(w.version.replace(/\\D/g,''))||100)+1}</td><td><span class="bdg blocked">canary</span></td><td>10%</td><td class="mut">2h ago</td><td style="text-align:right"><button class="btn sm no" onclick="toast('rolled back (sample)')">Rollback</button></td></tr>
    </tbody></table></div>
    <p class="mut" style="font-size:12px;margin-top:12px">Canary/rollback runs through the Fleet Router (epic 08). Stickiness wins over canary — a live session never flips version mid-run.</p>`;
}
function dwExposure() {
  const w = CUR; const pub = w.expose === 'public';
  $('#dwBody').innerHTML = `<div class="card"><div class="h"><h3>Exposure</h3></div><div class="b">
    <div class="srow"><span class="nm">Network reach</span><span class="sp"></span><span class="tag ${pub ? 'public' : ''}">${esc(w.expose)}</span></div>
    <div class="srow"><span class="nm">Public URL</span><span class="sp"></span><span class="sub">${pub ? 'https://' + w.name + '.agents.acme.com' : 'not exposed'}</span></div>
    <div class="srow"><span class="nm">Tunnel</span><span class="sp"></span><span class="sub">${pub ? 'Cloudflare named tunnel · healthy' : '—'}</span></div>
    <div class="srow"><span class="nm">Flip exposure</span><span class="sp"></span><button class="btn sm" onclick="toast('${pub ? 'unexpose' : 'expose'} (sample)')">${pub ? 'Make internal' : 'Expose publicly'}</button></div>
    <p class="mut" style="font-size:12px;margin-top:8px">Internal vs public differs only in network binding + auth — same worker, same controls, no rebuild (epic 09).</p>
  </div></div>`;
}
async function dwConfig() {
  if (!live()) return void ($('#dwBody').innerHTML = notLive('worker.yaml editing is available for live workspace workers.'));
  const d = await j('/api/workers/' + encodeURIComponent(CUR.id) + '/yaml');
  const rw = CAN('workers:config');
  $('#dwBody').innerHTML = `<textarea class="yaml" id="dwYaml" spellcheck="false" ${rw ? '' : 'readonly'}>${esc(d.yaml || '')}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center">${rw ? '<button class="btn p sm" id="dwSave">Validate &amp; save</button>' : `<span class="mut" style="font-size:12px">read-only — role "${esc(ME.role)}" cannot edit config</span>`}
    <span class="mut mono" style="font-size:11px">edits worker.yaml on disk · restart the worker to apply</span></div><div id="dwValid"></div>`;
  showValid(d);
  if (rw) $('#dwSave').onclick = async () => {
    try {
      const r = await api('/api/workers/' + encodeURIComponent(CUR.id) + '/yaml', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: $('#dwYaml').value }) });
      const v = await r.json(); showValid(v); if (v.saved) toast('worker.yaml saved');
    } catch (e) { /* handled */ }
  };
}
function showValid(d) { $('#dwValid').innerHTML = d.valid ? '<div class="valid ok">✓ valid worker.yaml (schema C2)</div>' : `<div class="valid bad">✗ ${esc((d.errors || ['invalid']).join('\n'))}</div>`; }
async function dwLogs() {
  if (!live()) return void ($('#dwBody').innerHTML = notLive('Logs stream from a live worker process.'));
  $('#dwBody').innerHTML = `<div class="logbox" id="dwLog">—</div>`;
  const load = async () => { const d = await j('/api/workers/' + encodeURIComponent(CUR.id) + '/logs'); const box = $('#dwLog'); if (!box) return; const b = box.scrollTop + box.clientHeight >= box.scrollHeight - 30; box.textContent = (d.logs || []).join('\n') || 'no logs — start the worker to see output.'; if (b) box.scrollTop = box.scrollHeight; };
  load(); logTimer = setInterval(load, 1500);
}

boot();
