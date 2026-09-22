export const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Airlock — Your agents</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="shell">
<header><div class="brand"><span class="mark" aria-hidden="true">a</span>airlock</div><div class="machine"><span class="dot"></span>This computer</div></header>
<main>
  <div class="eyebrow">Your agents</div>
  <h1>Ready when you are.</h1>
  <p class="intro">Choose an agent. Start it here. Take its link anywhere.</p>
  <section class="workspace" aria-label="Launch an agent">
    <div class="selection">
      <label class="field-label" for="framework">Framework</label>
      <select id="framework"><option value="">All frameworks</option></select>
      <label class="field-label" for="agent">Agent</label>
      <select id="agent" disabled><option>Finding your agents…</option></select>
      <p class="agent-path" id="agentPath">Looking in your current workspace.</p>
      <p class="framework-note">Your agent runs on this computer.</p>
      <button class="primary wide" id="start" disabled>Start agent <span aria-hidden="true">↗</span></button>
      <button class="quiet" id="local" disabled>Try on this computer first</button>
      <p class="error" id="error" role="alert" hidden></p>
    </div>
    <div class="connection">
      <div class="status" id="status" role="status" aria-live="polite"><i></i><span id="statusText">Not started</span></div>
      <div class="link-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 1 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)"/></svg></div>
      <h2 id="linkTitle">A link of its own.</h2>
      <p id="linkDescription">When your agent is online, its address appears here. Ready for your apps and other devices.</p>
      <div class="url" id="url" hidden></div>
      <div class="actions" id="actions" hidden>
        <button class="primary" id="copy">Copy link</button>
        <button class="secondary" id="manage">Manage agent</button>
        <button class="secondary" id="stop">Stop</button>
      </div>
      <div class="connection-bottom">Protected access · Managed automatically</div>
    </div>
  </section>
  <div class="notice" id="connectionNotice" hidden>
    <p><strong>This desktop can be your gateway.</strong><br>Set it up once, then start your agents here.</p>
    <button class="secondary" id="setup">Host a gateway</button>
  </div>
  <details id="settings" data-mode="desktop"><summary>Desktop gateway setup</summary>
    <div class="settings">
      <h2>Your computer. Your public address.</h2>
      <p>Airlock runs the gateway on this desktop and handles HTTPS for you. Keep this computer awake while your agent is available.</p>
      <label class="field-label" for="profile">Public address</label>
      <div class="row"><input id="profile" placeholder="agents.yourdomain.com" autocomplete="off" spellcheck="false" aria-describedby="addressHelp"><button class="secondary" id="save">Save address</button></div>
      <p id="addressHelp">Use a domain or subdomain you own. Airlock remembers it for future launches.</p>
      <p id="gatewayState" role="status">Checking this desktop…</p>
      <div class="actions"><button class="primary" id="gatewayInstall">Prepare this desktop</button><button class="secondary" id="gatewayCheck">Check connection</button></div>
      <p id="gatewayMessage" role="status" aria-live="polite"></p>
      <ul id="gatewayChecks" class="gateway-checks" aria-live="polite"></ul>
      <details><summary>What does my home network need?</summary>
        <p>Point your domain's DNS record to your home public IP. In your router, forward TCP ports 80 and 443 to this desktop, and allow Caddy through your firewall. Check connection shows this desktop's local addresses.</p>
        <p>If your internet provider uses shared addressing (CGNAT), ask for a public IP. Airlock cannot make an unreachable home connection public by itself.</p>
      </details>
    </div>
  </details>
  <div class="footer"><span>Runs here. Reaches anywhere.</span><span>Open source. Your infrastructure.</span></div>
</main></div><script src="/app.js"></script></body></html>`;
