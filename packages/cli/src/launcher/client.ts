export const client = String.raw`
const $=id=>document.getElementById(id);
const fragment=new URLSearchParams(location.hash.slice(1));
if(fragment.has('session')){sessionStorage.setItem('airlock-session',fragment.get('session'));history.replaceState(null,'','/');}
const session=sessionStorage.getItem('airlock-session')||'';
let snapshot={agents:[],status:'idle',active:null},busy=false,initialized=false;
const error=message=>{$('error').textContent=message;$('error').hidden=!message;};
async function api(path,body){
  const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Airlock-Session':session,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Something went wrong. Try again.');return result;
}
function choices(){
  const previous=$('agent').value,framework=$('framework').value;
  const agents=snapshot.agents.filter(agent=>!framework||agent.harness===framework);
  $('agent').replaceChildren(...agents.map(agent=>new Option(agent.name,agent.id)));
  if(agents.some(agent=>agent.id===previous))$('agent').value=previous;
  if(!agents.length)$('agent').append(new Option('No agents found',''));
  render();
}
function render(){
  const agent=snapshot.agents.find(agent=>agent.id===$('agent').value);
  const working=busy||snapshot.status==='starting',running=!!snapshot.active;
  if(snapshot.status==='error'&&snapshot.message)error(snapshot.message);
  $('agentPath').textContent=agent?agent.location:'Add a worker.yaml project to this workspace to get started.';
  $('agent').disabled=working||running||!snapshot.agents.length;$('framework').disabled=working||running;
  $('start').disabled=working||running||!agent;$('local').disabled=working||running||!agent;
  $('start').textContent=working?'Starting…':running?'Agent running':'Start agent ↗';
  $('local').hidden=running;$('connectionNotice').hidden=!!agent?.connected||running;
  $('status').dataset.state=snapshot.status;
  $('statusText').textContent=working?'Starting your agent…':running?(snapshot.active.local?'Running on this computer':'Online · Public link ready'):'Not started';
  $('linkTitle').textContent=running?(snapshot.active.local?'Your local preview.':'Your agent is online.'):'A link of its own.';
  $('linkDescription').textContent=running?(snapshot.active.local?'Only available on this computer. Connect your relay to use it from other devices.':'Copy this address for your apps and other devices. Access is protected.'):'When your agent is online, its address appears here. Ready for your apps and other devices.';
  $('url').hidden=!running;$('actions').hidden=!running;
  if(running)$('url').textContent=snapshot.active.url;
  $('stop').disabled=busy;
}
async function refresh(){
  snapshot=await api('state');
  if(!initialized){
    const labels={'stub':'Demo agent','own':'Airlock','langgraph':'LangGraph','smolagents':'Smolagents','crewai':'CrewAI','openai-agents':'OpenAI Agents','claude':'Claude'};
    for(const framework of [...new Set(snapshot.agents.map(agent=>agent.harness))])$('framework').append(new Option(labels[framework]||framework,framework));
    initialized=true;choices();
    if(snapshot.active)$('agent').value=snapshot.active.id;
  }
  render();
}
async function launch(local){
  busy=true;error('');render();
  try{await api('start',{id:$('agent').value,local});}
  catch(e){error(e.message);if(!local&&!snapshot.agents.find(agent=>agent.id===$('agent').value)?.connected)$('settings').open=true;}
  finally{busy=false;await refresh().catch(e=>error(e.message));}
}
$('framework').onchange=choices;$('agent').onchange=render;
$('start').onclick=()=>launch(false);$('local').onclick=()=>launch(true);
$('stop').onclick=async()=>{busy=true;render();try{await api('stop',{});error('');}catch(e){error(e.message);}finally{busy=false;await refresh().catch(e=>error(e.message));}};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(snapshot.active.url);$('copy').textContent='Copied';setTimeout(()=>$('copy').textContent='Copy link',1600);}catch{error('Select and copy the address above.');}};
$('manage').onclick=async()=>{try{const result=await api('console');location.href=result.url;}catch(e){error(e.message);}};
$('setup').onclick=()=>{$('settings').open=true;$('profile').focus();};
$('save').onclick=async()=>{try{await api('connection',{path:$('profile').value});await refresh();error('');$('settings').open=false;}catch(e){error(e.message);}};
refresh().catch(e=>error(e.message));
setInterval(()=>refresh().catch(e=>error(e.message)),2500);
`;
