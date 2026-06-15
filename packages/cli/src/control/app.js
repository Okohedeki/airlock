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
const SECTIONS = { overview: 'Overview', workers: 'Workers', runs: 'Runs', approvals: 'Approvals', tenants: 'Tenants', cost: 'Cost & usage', audit: 'Audit log', access: 'Access control' };
const envClass = (e) => e === 'prod' ? 'prod' : e === 'staging' ? 'staging' : 'dev';
const envScoped = (rows) => ENV === 'all' ? rows : rows.filter((r) => (r.env || 'dev') === ENV);

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

/* ---- header / env ---- */
async function boot() {
  const env = await j('/api/environments');
  $('#envSel').innerHTML = '<option value="all">All environments</option>' +
    (env.environments || []).map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join('');
  $('#envSel').onchange = (e) => { ENV = e.target.value; $('#envDot').className = 'envdot ' + (ENV === 'all' ? '' : envClass(ENV)); go(); };
  const acc = await j('/api/access');
  const me = (acc.users || [])[0]; const role = (acc.roles || []).find((r) => r.id === (me && me.role));
  if (me) { $('#acctName').textContent = me.name; $('#acctAv').textContent = me.name.split(' ').map((p) => p[0]).join('').slice(0, 2); $('#acctRole').textContent = role ? role.label : me.role; }
  go();
  setInterval(() => { if (!$('#scrim').classList.contains('on') && (location.hash.includes('overview') || location.hash.includes('workers') || location.hash === '' )) refreshCounts(); }, 6000);
}
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
  $('#page').innerHTML = `
  <div class="ph"><h1>Fleet overview</h1><span class="sub">real-time posture across all environments</span><span class="sp"></span><span class="sample">live + sample data</span></div>
  <div class="grid kpis" style="margin-bottom:14px">
    ${tile('Workers live', `${k.workersLive}<small>/${k.workersTotal}</small>`, '▲ healthy', 'up')}
    ${tile('Runs · 24h', num(k.runs24h), '+8.2% vs prior', 'up')}
    ${tile('Error rate', k.errorRatePct + '%', 'SLO 2.0%', k.errorRatePct > 2 ? 'down' : 'up')}
    ${tile('p95 latency', num(k.p95) + '<small>ms</small>', '−110ms', 'up')}
    ${tile('Spend · 24h', money(k.spend24h), 'budget $32k/mo', '')}
    ${tile('Approvals', k.pendingApprovals, 'awaiting human', k.pendingApprovals ? 'down' : '')}
  </div>
  <div class="grid cols3" style="margin-bottom:14px">
    <div class="card"><div class="h"><h3>Run volume · 24h</h3><span class="sp"></span><span class="hint">runs/hr</span></div><div class="b">${spark(d.runVolume)}</div></div>
    <div class="card"><div class="h"><h3>Active alerts</h3></div><div>${(d.alerts || []).map((a) => `<div class="alert"><span class="sev ${a.sev}">${a.sev}</span><div><b>${esc(a.worker)}</b> — ${esc(a.msg)}</div><span class="sp"></span><span class="env ${envClass(a.env)}">${esc(a.env)}</span></div>`).join('')}</div></div>
  </div>
  <div class="grid cols2" style="margin-bottom:14px">
    <div class="card"><div class="h"><h3>p95 latency · 24h</h3><span class="sp"></span><span class="hint">ms</span></div><div class="b">${spark(d.latency, 130, 'var(--model)')}</div></div>
    <div class="card"><div class="h"><h3>Spend · 24h</h3><span class="sp"></span><span class="hint">$ / hr</span></div><div class="b">${spark(d.cost, 130, 'var(--prod)')}</div></div>
  </div>
  <div class="card"><div class="h"><h3>Top tenants by spend</h3><span class="sp"></span><span class="sample">sample</span></div>
    <table><thead><tr><th>Tenant</th><th>Plan</th><th class="num">RPS</th><th class="num">Runs 24h</th><th class="num">Cost MTD</th></tr></thead><tbody>
    ${(d.topTenants || []).map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${esc(t.plan)}</td><td class="num">${t.rps}</td><td class="num">${num(t.runs24h)}</td><td class="num">${money(t.costMtd)}</td></tr>`).join('')}
    </tbody></table></div>`;
  refreshCounts();
};

RENDER.workers = async () => {
  const d = await j('/api/workers'); WORKERS = d.workers || []; $('#wsPath').textContent = (d.root || '').split('/').slice(-1)[0];
  const rows = envScoped(WORKERS);
  $('#page').innerHTML = `
  <div class="ph"><h1>Workers</h1><span class="sub">${rows.length} agents across the fleet</span><span class="sp"></span></div>
  <div class="card">
    <div class="toolbar">
      <input id="wf" placeholder="Filter by name…" style="min-width:200px">
      <select id="wfStatus"><option value="">All status</option><option>running</option><option>healthy</option><option>degraded</option><option>error</option><option>stopped</option><option>idle</option></select>
      <select id="wfExpose"><option value="">All exposure</option><option>public</option><option>internal</option></select>
      <span class="sp"></span><span class="hint mut" style="font-family:var(--mono);font-size:11px">live workers are operable · others are representative</span>
    </div>
    <table><thead><tr><th>Worker</th><th>Env</th><th>Status</th><th>Harness</th><th>Version</th><th>Expose</th><th class="num">RPS</th><th class="num">p95</th><th class="num">Err%</th><th class="num">$/24h</th><th></th></tr></thead>
    <tbody id="wkBody"></tbody></table>
  </div>`;
  const draw = () => {
    const q = ($('#wf').value || '').toLowerCase(), st = $('#wfStatus').value, ex = $('#wfExpose').value;
    const f = rows.filter((w) => (!q || w.name.toLowerCase().includes(q)) && (!st || (w.health === st || w.status === st)) && (!ex || w.expose === ex));
    $('#wkBody').innerHTML = f.length ? f.map((w) => {
      const live = !w.sample; const status = w.status === 'running' ? 'running' : (w.health || w.status);
      return `<tr>
        <td><span class="nm" data-id="${esc(w.id)}">${esc(w.name)}</span> ${live && w.status === 'running' ? '<span class="live-chip">live</span>' : ''}</td>
        <td><span class="env ${envClass(w.env)}">${esc(w.env)}</span></td>
        <td><span class="st"><span class="dot ${w.status === 'running' ? 'running live' : (w.health || w.status)}"></span>${esc(status)}</span></td>
        <td class="mono">${esc(w.harness)}</td><td class="mono">${esc(w.version)}</td>
        <td><span class="tag ${w.expose}">${esc(w.expose)}</span></td>
        <td class="num">${w.rps}</td><td class="num">${num(w.p95)}</td><td class="num">${w.errPct}</td><td class="num">${money(w.cost24h)}</td>
        <td style="text-align:right">${live
          ? (w.status === 'running'
            ? `<button class="btn sm no" data-act="stop" data-id="${esc(w.id)}">Stop</button>`
            : `<button class="btn sm p" data-act="start" data-id="${esc(w.id)}">Start</button>`)
          : '<span class="mut" style="font-size:11px">—</span>'}</td></tr>`;
    }).join('') : '<tr><td colspan="11" class="empty">no workers match.</td></tr>';
    $('#wkBody').querySelectorAll('.nm').forEach((n) => n.onclick = () => openWorker(n.dataset.id));
    $('#wkBody').querySelectorAll('button[data-act]').forEach((b) => b.onclick = () => act(b.dataset.id, b.dataset.act, b));
  };
  ['wf', 'wfStatus', 'wfExpose'].forEach((id) => $('#' + id).oninput = draw);
  draw();
};
async function act(id, action, btn) {
  if (btn) { btn.disabled = true; btn.textContent = action === 'start' ? '…' : '…'; }
  await fetch(`/api/workers/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  toast('worker ' + (action === 'start' ? 'started' : 'stopped')); RENDER.workers();
}

RENDER.runs = async () => {
  const d = await j('/api/runs'); const rows = d.runs || [];
  $('#page').innerHTML = `
  <div class="ph"><h1>Runs</h1><span class="sub">fleet-wide agent workflow executions</span><span class="sp"></span><span class="sample">live + sample</span></div>
  <div class="card"><div class="toolbar"><input id="rf" placeholder="Filter by worker or tenant…" style="min-width:240px">
    <select id="rfStatus"><option value="">All status</option><option>ok</option><option>blocked</option><option>stopped</option><option>error</option></select><span class="sp"></span></div>
    <table><thead><tr><th>Run</th><th>Worker</th><th>Tenant</th><th>Status</th><th class="num">Steps</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Age</th></tr></thead><tbody id="rnBody"></tbody></table></div>`;
  const draw = () => {
    const q = ($('#rf').value || '').toLowerCase(), st = $('#rfStatus').value;
    const f = rows.filter((r) => (!q || (r.worker + r.tenant).toLowerCase().includes(q)) && (!st || r.status === st));
    $('#rnBody').innerHTML = f.length ? f.map((r) => `<tr><td class="mono">${esc(r.id)} ${r.live ? '<span class="live-chip">live</span>' : ''}</td>
      <td><b>${esc(r.worker)}</b></td><td>${esc(r.tenant)}</td><td><span class="bdg ${r.status}">${esc(r.status)}</span></td>
      <td class="num">${r.steps}</td><td class="num">${num(r.tokens)}</td><td class="num">${money(r.costUsd, 2)}</td><td class="num">${r.live ? 'live' : ago(r.ageMins)}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">no runs match.</td></tr>';
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
    <td style="text-align:right;white-space:nowrap">${h.live
      ? `<button class="btn sm ok" onclick="decide('${esc(h.workerId)}','${esc(h.run)}','approve')">Approve</button> <button class="btn sm no" onclick="decide('${esc(h.workerId)}','${esc(h.run)}','deny')">Deny</button>`
      : `<button class="btn sm ok" onclick="toast('approved (sample)')">Approve</button> <button class="btn sm no" onclick="toast('denied (sample)')">Deny</button>`}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">nothing holding — guarded tools appear here when a run pauses.</td></tr>'}
  </tbody></table></div>`;
};
window.decide = async (wid, run, decision) => {
  await fetch(`/api/workers/${encodeURIComponent(wid)}/proxy/v1/runs/${encodeURIComponent(run)}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
  toast('run ' + decision + 'd'); RENDER.approvals();
};

RENDER.tenants = async () => {
  const d = await j('/api/tenants'); const t = d.tenants || [];
  $('#page').innerHTML = `<div class="ph"><h1>Tenants</h1><span class="sub">callers of your public agents</span><span class="sp"></span><span class="sample">sample</span></div>
  <div class="card"><table><thead><tr><th>Tenant</th><th>Plan</th><th>Status</th><th>API key</th><th class="num">RPS / limit</th><th class="num">Runs 24h</th><th class="num">Tokens 24h</th><th class="num">Cost MTD</th></tr></thead><tbody>
  ${t.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.plan)}</td>
    <td><span class="st"><span class="dot ${x.status}"></span>${esc(x.status)}</span></td>
    <td class="mono">${esc(x.keyPrefix)}…</td>
    <td class="num">${x.rps} / ${x.limitRps}<div class="barwrap" style="margin-top:4px;width:90px;margin-left:auto"><i style="width:${Math.min(100, (x.rps / x.limitRps) * 100)}%"></i></div></td>
    <td class="num">${num(x.runs24h)}</td><td class="num">${num(x.tokens24h)}</td><td class="num">${money(x.costMtd)}</td></tr>`).join('')}
  </tbody></table></div>`;
};

RENDER.cost = async () => {
  const d = await j('/api/cost');
  $('#page').innerHTML = `<div class="ph"><h1>Cost &amp; usage</h1><span class="sub">spend metering across the fleet</span><span class="sp"></span><span class="sample">live tokens + sample rates</span></div>
  <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
    <div class="kpi"><div class="k">Spend · MTD</div><div class="v">${money((d.byEnv || []).reduce((a, e) => a + e.cost, 0))}</div><div class="d">of ${money(d.budget)} budget</div></div>
    <div class="kpi"><div class="k">Production</div><div class="v">${money((d.byEnv || []).find((e) => e.env === 'prod')?.cost || 0)}</div></div>
    <div class="kpi"><div class="k">Staging</div><div class="v">${money((d.byEnv || []).find((e) => e.env === 'staging')?.cost || 0)}</div></div>
    <div class="kpi"><div class="k">Development</div><div class="v">${money((d.byEnv || []).find((e) => e.env === 'dev')?.cost || 0)}</div></div>
  </div>
  <div class="card" style="margin-bottom:14px"><div class="h"><h3>Daily spend · 30d</h3><span class="sp"></span><span class="hint">$ / day</span></div><div class="b">${bars(d.series)}</div></div>
  <div class="card"><div class="h"><h3>Spend by tenant</h3></div><table><thead><tr><th>Tenant</th><th>Plan</th><th class="num">Cost MTD</th><th>Share</th></tr></thead><tbody>
  ${(() => { const mx = Math.max(...(d.tenants || []).map((t) => t.costMtd), 1); return (d.tenants || []).map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${esc(t.plan)}</td><td class="num">${money(t.costMtd)}</td><td style="width:220px"><div class="barwrap"><i style="width:${(t.costMtd / mx) * 100}%"></i></div></td></tr>`).join(''); })()}
  </tbody></table></div>`;
};

RENDER.audit = async () => {
  const d = await j('/api/audit'); const ev = d.events || [];
  $('#page').innerHTML = `<div class="ph"><h1>Audit log</h1><span class="sub">immutable record of every privileged action</span><span class="sp"></span><span class="sample">live actions + sample history</span></div>
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
    <div class="card"><div class="h"><h3>Single sign-on</h3><span class="sp"></span><span class="bdg ok">enforced</span></div><div class="b"><div class="kv">
      <div class="k">Provider</div><div class="v">${esc(sso.provider)} · ${esc(sso.protocol)}</div>
      <div class="k">Domain</div><div class="v">${esc(sso.domain)}</div>
      <div class="k">MFA</div><div class="v">${esc(sso.mfa)}</div>
      <div class="k">SCIM provisioning</div><div class="v">${sso.scimProvisioning ? 'enabled' : 'disabled'}</div></div></div></div>
    <div class="card"><div class="h"><h3>Environments</h3></div><div class="b">${(d.environments || []).map((e) => `<div class="srow"><span class="env ${envClass(e.id)}">${esc(e.label)}</span><span class="sp"></span><span class="sub">${e.id === 'prod' ? 'change control · 2-person approval' : e.id === 'staging' ? 'operators + approvers' : 'all engineers'}</span></div>`).join('')}</div></div>
  </div>
  <div class="card" style="margin-bottom:14px"><div class="h"><h3>Members</h3><span class="sp"></span><span class="hint">${(d.users || []).length} users</span></div>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>SSO</th><th>Last active</th></tr></thead><tbody>
    ${(d.users || []).map((u) => { const role = (d.roles || []).find((r) => r.id === u.role); return `<tr><td><b>${esc(u.name)}</b></td><td class="mono">${esc(u.email)}</td><td><span class="rolechip">${esc(role ? role.label : u.role)}</span></td><td>${u.sso ? '✓' : '—'}</td><td class="mut">${ago(u.lastActiveMins)} ago</td></tr>`; }).join('')}
    </tbody></table></div>
  <div class="card"><div class="h"><h3>Roles</h3></div><table><thead><tr><th>Role</th><th>Description</th><th>Permissions</th></tr></thead><tbody>
    ${(d.roles || []).map((r) => `<tr><td><span class="rolechip">${esc(r.label)}</span></td><td>${esc(r.desc)}</td><td class="mono mut">${r.perms.map(esc).join(' · ')}</td></tr>`).join('')}
  </tbody></table></div>`;
};

/* ============================ WORKER DRAWER ============================ */
let CUR = null, logTimer = null;
window.openWorker = async (id) => {
  const w = WORKERS.find((x) => x.id === id) || (await j('/api/workers/' + encodeURIComponent(id)));
  CUR = w; if (logTimer) { clearInterval(logTimer); logTimer = null; }
  $('#dwName').textContent = w.name;
  $('#dwEnv').className = 'env ' + envClass(w.env); $('#dwEnv').textContent = w.env;
  $('#dwHarness').textContent = w.harness + (w.version ? ' · ' + w.version : '');
  $('#dwDot').className = 'dot ' + (w.status === 'running' ? 'running' : (w.health || w.status));
  const live = !w.sample;
  const tabs = ['Overview', 'Controls', 'Versions', 'Exposure', 'Config', 'Logs'];
  $('#dwTabs').innerHTML = tabs.map((t, i) => `<button data-t="${t.toLowerCase()}" class="${i === 0 ? 'on' : ''}">${t}</button>`).join('');
  $('#dwTabs').querySelectorAll('button').forEach((b) => b.onclick = () => dwTab(b.dataset.t));
  $('#scrim').classList.add('on'); $('#drawer').classList.add('on');
  dwTab('overview');
};
function closeDrawer() { $('#scrim').classList.remove('on'); $('#drawer').classList.remove('on'); CUR = null; if (logTimer) { clearInterval(logTimer); logTimer = null; } }
$('#dwClose').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
function dwTab(name) {
  $('#dwTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  ({ overview: dwOverview, controls: dwControls, versions: dwVersions, exposure: dwExposure, config: dwConfig, logs: dwLogs }[name] || dwOverview)();
}
const live = () => CUR && !CUR.sample;
const notLive = (msg) => `<div class="empty">${msg}</div>`;

function dwOverview() {
  const w = CUR; const m = (sub) => `<div class="kpi"><div class="k">${sub[0]}</div><div class="v">${sub[1]}</div></div>`;
  $('#dwBody').innerHTML = `
  <div class="grid kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
    ${m(['Status', `<span class="st" style="font-size:18px"><span class="dot ${w.status === 'running' ? 'running' : (w.health || w.status)}"></span>${w.status === 'running' ? 'running' : (w.health || w.status)}</span>`])}
    ${m(['RPS', w.rps])}${m(['p95', num(w.p95) + 'ms'])}${m(['Error rate', w.errPct + '%'])}${m(['Cost · 24h', money(w.cost24h)])}${m(['Tenants', w.tenants])}
  </div>
  <div class="card"><div class="h"><h3>Identity</h3>${w.sample ? '<span class="sp"></span><span class="sample">representative</span>' : ''}</div><div class="b"><div class="kv">
    <div class="k">Worker</div><div class="v">${esc(w.name)}</div><div class="k">Environment</div><div class="v">${esc(w.env)}</div>
    <div class="k">Harness</div><div class="v">${esc(w.harness)}</div><div class="k">Version</div><div class="v">${esc(w.version)}</div>
    <div class="k">Exposure</div><div class="v">${esc(w.expose)}</div>${w.port ? `<div class="k">Address</div><div class="v">127.0.0.1:${w.port}</div>` : ''}
  </div></div></div>`;
}
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
}
window.ctl = (p, body) => fetch(`/api/workers/${encodeURIComponent(CUR.id)}/proxy/v1/control/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(() => { toast('applied to next run'); dwControls(); });
window.ctlSkill = (id, on) => ctl('skills/' + encodeURIComponent(id), { enabled: on });
window.ctlAppr = (t, on) => ctl('controls', { approval: { tool: t, on } });
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
  $('#dwBody').innerHTML = `<textarea class="yaml" id="dwYaml" spellcheck="false">${esc(d.yaml || '')}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><button class="btn p sm" id="dwSave">Validate &amp; save</button>
    <span class="mut mono" style="font-size:11px">edits worker.yaml on disk · restart the worker to apply</span></div><div id="dwValid"></div>`;
  showValid(d); $('#dwSave').onclick = async () => {
    const r = await fetch('/api/workers/' + encodeURIComponent(CUR.id) + '/yaml', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: $('#dwYaml').value }) });
    const v = await r.json(); showValid(v); if (v.saved) toast('worker.yaml saved');
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
