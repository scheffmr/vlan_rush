// VLAN-Rush V4 client
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const sb = document.getElementById('scoreboard');

let ws, myId=null, mapSize=2000;
const players = new Map(); // id -> {x,y,score,alive,name,avatar,trail:[]}
let orbs = [];

// UI
const joinBox = document.getElementById('join');
const statusEl = document.getElementById('status');
document.getElementById('joinBtn').onclick = ()=>{
  connectWS(()=>{
    const name = document.getElementById('name').value || `Player${Math.floor(Math.random()*1000)}`;
    const avatar = document.getElementById('avatar').value || 'packet';
    send({type:'join', name, avatar});
  });
};

function connectWS(onOpen){
  const url = (location.protocol==='https:'?'wss://':'ws://') + location.host;
  ws = new WebSocket(url);
  ws.onopen = ()=>{ status('verbunden'); if (onOpen) onOpen(); };
  ws.onclose = ()=>{ status('getrennt — VLAN/Trunk prüfen'); setTimeout(()=> connectWS(()=>{ if (myId && players.get(myId)) send({type:'join', name: players.get(myId).name, avatar: players.get(myId).avatar}); }), 1200); };
  ws.onerror = ()=> status('WS-Fehler');
  ws.onmessage = onMessage;
}
function status(t){ if(statusEl) statusEl.textContent = t; }
function send(o){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function onMessage(ev){
  const msg = JSON.parse(ev.data);
  if (msg.type==='hello'){
    mapSize = msg.mapSize; orbs = msg.orbs||[];
  } else if (msg.type==='welcome'){
    myId = msg.id; mapSize = msg.mapSize; orbs = msg.orbs||[];
    players.clear();
    msg.players.forEach(p=> players.set(p.id, {...p, trail:[]}));
    if (joinBox) joinBox.style.display='none';
  } else if (msg.type==='spawn'){
    players.set(msg.player.id, {...msg.player, trail: []});
  } else if (msg.type==='despawn'){
    players.delete(msg.id);
  } else if (msg.type==='death'){
    const p=players.get(msg.id); if (p) { p.alive=false; p.trail.length=0; }
  } else if (msg.type==='orb'){
    const p = players.get(msg.id); if (p) p.score = msg.score;
    if (typeof msg.remove==='number') orbs.splice(msg.remove,1);
    if (msg.add) orbs.push(msg.add);
  } else if (msg.type==='reset'){
    players.clear();
    msg.players.forEach(p=> players.set(p.id, {...p, trail:[]}));
    orbs = msg.orbs || [];
  } else if (msg.type==='state'){
    msg.players.forEach(s=>{
      let p = players.get(s.id);
      if (!p){
        p = {id:s.id,name:s.name||('P'+s.id),avatar:s.avatar||'packet',x:s.x,y:s.y,score:s.score,alive:s.alive,trail:[]};
        players.set(s.id,p);
      }
      if (s.alive){
        p.trail.push({x:s.x, y:s.y, t:performance.now(), score:s.score});
        const keep = 120 + s.score*6; // visual length = server logic
        if (p.trail.length>keep) p.trail.splice(0, p.trail.length-keep);
      }
      p.x=s.x; p.y=s.y; p.score=s.score; p.alive=s.alive; p.avatar=s.avatar||p.avatar;
    });
  }
}

// input
const keys = {};
window.addEventListener('keydown', e=> keys[e.code]=true);
window.addEventListener('keyup', e=> keys[e.code]=false);
window.addEventListener('mousemove', e=>{
  if (!myId || !players.has(myId)) return;
  const me = players.get(myId);
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const cam = camera();
  const wx = mx + cam.x, wy = my + cam.y;
  const ang = Math.atan2(wy - me.y, wx - me.x);
  send({type:'input', dir: ang});
});

let last = performance.now();
function loop(ts){
  const dt = (ts-last)/1000; last = ts;
  // keyboard steering (WASD) + Shift boost
  if (myId && players.has(myId)){
    const dx = (keys['KeyD']?1:0) - (keys['KeyA']?1:0);
    const dy = (keys['KeyS']?1:0) - (keys['KeyW']?1:0);
    if (dx||dy){
      const ang = Math.atan2(dy, dx);
      send({type:'input', dir: ang});
    }
    send({type:'input', boost: !!keys['ShiftLeft'] || !!keys['ShiftRight']});
  }
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function camera(){
  const w=canvas.width, h=canvas.height;
  if (!myId || !players.has(myId)){
    return {x: mapSize/2 - w/2, y: mapSize/2 - h/2};
  }
  const me = players.get(myId);
  let x = me.x - w/2, y = me.y - h/2;
  x = Math.max(0, Math.min(mapSize - w, x));
  y = Math.max(0, Math.min(mapSize - h, y));
  return {x,y};
}

function draw(){
  const w=canvas.width, h=canvas.height;
  const cam = camera();
  ctx.clearRect(0,0,w,h);

  // grid
  ctx.globalAlpha = 0.15;
  for (let x=0;x<mapSize;x+=100) ctx.fillRect(x-cam.x, 0-cam.y, 1, mapSize);
  for (let y=0;y<mapSize;y+=100) ctx.fillRect(0-cam.x, y-cam.y, mapSize, 1);
  ctx.globalAlpha = 1;

  // border
  ctx.strokeStyle = '#2a2f4a';
  ctx.strokeRect(-cam.x, -cam.y, mapSize, mapSize);

  // orbs
  ctx.fillStyle = '#7aa2f7';
  orbs.forEach(o=>{ ctx.beginPath(); ctx.arc(o.x-cam.x, o.y-cam.y, 6, 0, Math.PI*2); ctx.fill(); });

  // trails
  for (const p of players.values()){
    if (!p.alive || !p.trail || p.trail.length<2) continue;
    const width = 6 + Math.floor(p.score/5);
    for (let i=1;i<p.trail.length;i++){
      const a = p.trail[i-1], b = p.trail[i];
      const age = (performance.now() - a.t)/1000;
      const alpha = Math.max(0.2, 1.1 - age*0.9);
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(122,162,247,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.x - cam.x, a.y - cam.y);
      ctx.lineTo(b.x - cam.x, b.y - cam.y);
      ctx.stroke();
    }
  }

  // heads
  for (const p of players.values()){
    if (!p.alive) continue;
    drawHead(p, cam);
  }

  renderScoreboard();
}

function drawHead(p, cam){
  const x = p.x - cam.x, y = p.y - cam.y;
  if (p.avatar==='cat'){
    rect(x-10,y-10,20,20,'#f2f2f7'); tri(x-8,y-10,x-2,y-18,x+4,y-10,'#f2f2f7'); tri(x+8,y-10,x+2,y-18,x-4,y-10,'#f2f2f7'); dot(x-4,y-2); dot(x+4,y-2);
  } else if (p.avatar==='robot'){
    rect(x-12,y-12,24,24,'#7aa2f7'); rect(x-6,y-2,12,6,'#0a0d18'); dot(x-5,y-4); dot(x+5,y-4); rect(x-1,y-18,2,6,'#7aa2f7');
  } else {
    rect(x-12,y-8,24,16,'#e0af68'); ctx.fillStyle='#0a0d18'; ctx.fillRect(x-5,y-3,10,2);
  }
  ctx.fillStyle='#fff'; ctx.font='12px system-ui'; ctx.textAlign='center';
  ctx.fillText(`${p.name} (${p.score})`, x, y-18);
}

function rect(x,y,w,h,c){ ctx.fillStyle=c; ctx.fillRect(x,y,w,h); }
function tri(x1,y1,x2,y2,x3,y3,c){ ctx.fillStyle=c; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.lineTo(x3,y3); ctx.closePath(); ctx.fill(); }
function dot(x,y){ ctx.fillStyle='#0a0d18'; ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill(); }

function renderScoreboard(){
  const list = Array.from(players.values()).sort((a,b)=> b.score - a.score).slice(0,20);
  sb.innerHTML = list.map(p=> `<div class="scoreitem"><span class="name">${esc(p.name)}</span><span>${p.score}</span></div>`).join('');
}
function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Connect immediately, so Admin page also works if someone opens index without joining
connectWS();
