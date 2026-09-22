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
    <p><strong>Connect once. Launch whenever.</strong><br>Public links need a connection to your relay server.</p>
    <button class="secondary" id="setup">Set up connection</button>
  </div>
  <details id="settings"><summary>Connection settings</summary>
    <div class="settings"><p>Use the connection profile from your relay setup. This is saved for the launcher session. Your agent credentials are handled by Airlock.</p>
      <label class="field-label" for="profile">Connection profile</label>
      <div class="row"><input id="profile" placeholder="Path to relay.json" autocomplete="off"><button class="secondary" id="save">Use connection</button></div>
      <p id="connectionHelp">A relay server and domain are required for public links. Automatic server setup is not available yet.</p>
    </div>
  </details>
  <div class="footer"><span>Runs here. Reaches anywhere.</span><span>Open source. Your infrastructure.</span></div>
</main></div><script src="/app.js"></script></body></html>`;
