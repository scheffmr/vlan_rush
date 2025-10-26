// LAN Rush client
const isSpectator = !!window.SPECTATOR;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const sb = document.getElementById('scoreboard');

let ws, myId=null, mode='collect', mapSize=1600, round={running:false, timeLimitSec:300, scoreLimit:50, startedAt:0};
const players = new Map(); // id -> {x,y,score,avatar,name}
let pellets = [];
let flags = {};
let hill = null;

// UI elements (non-spectator)
const joinBtn = document.getElementById('joinBtn');
const statusEl = document.getElementById('status');

if (!isSpectator){
  joinBtn.onclick = connectAndJoin;
} else {
  // spectator: auto-connect read-only
  connectWS();
}

function connectAndJoin(){
  const name = document.getElementById('name').value || `Player${Math.floor(Math.random()*1000)}`;
  const avatar = document.getElementById('avatar').value || 'packet';
  connectWS(()=>{
    send({type:'join', name, avatar});
  });
}

function connectWS(onOpen){
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  ws = new WebSocket(url);
  ws.onopen = ()=>{
    status('Verbunden.');
    if (onOpen) onOpen();
  };
  ws.onclose = ()=>{
    status('Verbindung getrennt. Prüfe VLAN/Trunk?');
    setTimeout(()=> connectWS(()=>{
      if (myId) send({type:'join', name: players.get(myId)?.name || 'Player', avatar: players.get(myId)?.avatar || 'packet'});
    }), 1500);
  };
  ws.onerror = ()=> status('WS-Fehler');
  ws.onmessage = onMessage;
}

function status(t){
  if (statusEl) statusEl.textContent = t;
}

function onMessage(ev){
  const msg = JSON.parse(ev.data);
  if (msg.type === 'hello'){
    mode = msg.mode; mapSize = msg.mapSize; round = msg.round;
  } else if (msg.type === 'welcome'){
    myId = msg.id;
    mode = msg.mode; mapSize = msg.mapSize; round = msg.round;
    players.clear();
    msg.players.forEach(p=> players.set(p.id, p));
    pellets = msg.pellets || [];
    flags = msg.flags || {};
    hill = msg.hill || null;
  } else if (msg.type === 'spawn'){
    players.set(msg.player.id, msg.player);
  } else if (msg.type === 'despawn'){
    players.delete(msg.id);
  } else if (msg.type === 'pos'){
    const p = players.get(msg.id);
    if (p){ p.x = msg.x; p.y = msg.y; p.score = msg.s; }
  } else if (msg.type === 'pickup'){
    const p = players.get(msg.id);
    if (p){ p.score = msg.score; }
    pellets.splice(msg.pelletIndex,1);
  } else if (msg.type === 'roundStart'){
    round = msg.round; mode = msg.mode;
    pellets = msg.pellets || []; flags = msg.flags || {}; hill = msg.hill || null;
  } else if (msg.type === 'roundEnd'){
    // show small toast
    status('Runde Ende: ' + (msg.reason||''));
  } else if (msg.type === 'mode'){
    mode = msg.mode;
  } else if (msg.type === 'roundLimits'){
    round.scoreLimit = msg.scoreLimit; round.timeLimitSec = msg.timeLimitSec;
  }
}

// Input
const keys = {};
window.addEventListener('keydown', e=> keys[e.code]=true);
window.addEventListener('keyup', e=> keys[e.code]=false);

function send(obj){
  if (ws && ws.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify(obj));
  }
}

// Game loop
let last = performance.now();
function loop(ts){
  const dt = (ts - last)/1000; last = ts;
  update(dt); draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

let inputTick = 0;
function update(dt){
  // local input -> send to server
  inputTick += dt;
  if (!isSpectator && myId){
    const dx = (keys['KeyD']?1:0) - (keys['KeyA']?1:0);
    const dy = (keys['KeyS']?1:0) - (keys['KeyW']?1:0);
    if (dx || dy){
      if (inputTick > 0.02){
        send({type:'input', dx, dy});
        inputTick = 0;
      }
    }
  }
  // update scoreboard
  renderScoreboard();
}

function draw(){
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  // camera: center on me if not spectator
  let camX = 0, camY = 0;
  if (!isSpectator && myId && players.has(myId)){
    const me = players.get(myId);
    camX = me.x - w/2; camY = me.y - h/2;
  } else {
    // spectator: center map
    camX = mapSize/2 - w/2; camY = mapSize/2 - h/2;
  }
  // clamp camera
  camX = Math.max(0, Math.min(mapSize - w, camX));
  camY = Math.max(0, Math.min(mapSize - h, camY));

  // grid
  ctx.globalAlpha = 0.2;
  for (let x=0; x<mapSize; x+=80){
    ctx.fillRect(x - camX, 0 - camY, 1, mapSize);
  }
  for (let y=0; y<mapSize; y+=80){
    ctx.fillRect(0 - camX, y - camY, mapSize, 1);
  }
  ctx.globalAlpha = 1;

  // draw pellets
  if (mode === 'collect'){
    ctx.fillStyle = '#7aa2f7';
    pellets.forEach(t=>{
      ctx.beginPath();
      ctx.arc(t.x - camX, t.y - camY, 7, 0, Math.PI*2);
      ctx.fill();
    });
  }

  // draw flags
  if (mode === 'ctf'){
    ctx.fillStyle = '#f7768e';
    if (flags.A){
      ctx.fillRect(flags.A.x - 8 - camX, flags.A.y - 16 - camY, 16, 16);
    }
    ctx.fillStyle = '#9ece6a';
    if (flags.B){
      ctx.fillRect(flags.B.x - 8 - camX, flags.B.y - 16 - camY, 16, 16);
    }
  }

  // draw hill
  if (mode === 'king' && hill){
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.arc(hill.x - camX, hill.y - camY, hill.r, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // draw players
  for (const p of players.values()){
    drawPlayer(p, camX, camY);
  }

  // status bar
  drawStatusBar();
}

function drawPlayer(p, camX, camY){
  const x = p.x - camX, y = p.y - camY;
  // avatar styles
  if (p.avatar === 'cat'){
    // cat head
    rect(x-10,y-10,20,20,'#f2f2f7');
    tri(x-8,y-10,x-2,y-18,x+4,y-10,'#f2f2f7');
    tri(x+8,y-10,x+2,y-18,x-4,y-10,'#f2f2f7');
    dot(x-4,y-2); dot(x+4,y-2); // eyes
  } else if (p.avatar === 'robot'){
    rect(x-12,y-12,24,24,'#7aa2f7');
    rect(x-6,y-2,12,6,'#0a0d18'); // mouth
    dot(x-5,y-4); dot(x+5,y-4);   // eyes
    rect(x-1,y-18,2,6,'#7aa2f7'); // antenna
  } else {
    // packet
    rect(x-12,y-8,24,16,'#e0af68');
    ctx.fillStyle = '#0a0d18'; ctx.fillRect(x-5,y-3,10,2);
  }
  // nametag
  ctx.fillStyle = '#fff';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(`${p.name} (${p.score})`, x, y-18);
}

function rect(x,y,w,h,color){
  ctx.fillStyle = color; ctx.fillRect(x,y,w,h);
}
function tri(x1,y1,x2,y2,x3,y3,color){
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.lineTo(x3,y3); ctx.closePath(); ctx.fill();
}
function dot(x,y){ ctx.fillStyle = '#0a0d18'; ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill(); }

function renderScoreboard(){
  if (!sb) return;
  const list = Array.from(players.values()).sort((a,b)=> b.score - a.score).slice(0,20);
  sb.innerHTML = list.map(p=> `<div class="scoreitem"><span class="name">${esc(p.name)}</span><span class="stat">${p.score}</span></div>`).join('');
}
function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function drawStatusBar(){
  const t = document.querySelector('.statusbar') || (()=>{
    const d = document.createElement('div'); d.className='statusbar'; document.body.appendChild(d); return d;
  })();
  const running = round.running ? 'läuft' : 'gestoppt';
  let remain = '';
  if (round.running && round.timeLimitSec>0){
    const elapsed = Math.floor((Date.now() - round.startedAt)/1000);
    const left = Math.max(0, round.timeLimitSec - elapsed);
    remain = ` | Rest: ${left}s`;
  }
  t.textContent = `Modus: ${mode} | Runde: ${running} | Score-Limit: ${round.scoreLimit}${remain}`;
}
