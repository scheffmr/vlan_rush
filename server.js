
// VLAN-Rush V2 — IO Edition (no external deps)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf-8'));
const PORT = Number(process.env.PORT || cfg.port || 3000);
const MAP_SIZE = cfg.mapSize || 1800;
const MAX_PLAYERS = cfg.maxPlayers || 20;
const ORB_COUNT = cfg.orbCount || 120;
const TICKRATE = cfg.tickRate || 30; // Hz
const RESPAWN_DELAY = cfg.respawnDelayMs || 1500;

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'
};

const state = {
  players: new Map(), // id -> {id,name,avatar,x,y,dir,spd,score,alive,trail:[{x,y,t}]}
  sockets: new Map(), // socket -> id
  orbs: [],           // {x,y}
};

function rand(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function now(){ return Date.now(); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

function spawnOrbs(n){
  for(let i=0;i<n;i++){
    state.orbs.push({x: rand(40, MAP_SIZE-40), y: rand(40, MAP_SIZE-40)});
  }
}
spawnOrbs(ORB_COUNT);

// Static server
function sendFile(res, filePath){
  fs.readFile(filePath,(err,data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
}
const server = http.createServer((req,res)=>{
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const filePath = path.join(__dirname,'public',url);
  if (!filePath.startsWith(path.join(__dirname,'public'))){ res.writeHead(403).end('Forbidden'); return; }
  fs.stat(filePath,(err,st)=>{
    if(err || !st.isFile()){ res.writeHead(404).end('Not found'); return; }
    sendFile(res,filePath);
  });
});

// Minimal WS
const clients = new Set();
server.on('upgrade',(req,socket,head)=>{
  if (req.headers['upgrade']!=='websocket'){ socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const acceptKey = require('crypto').createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11','binary').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade',`Sec-WebSocket-Accept: ${acceptKey}`,'',''
  ].join('\r\n'));
  socket.isAlive=true; socket.on('pong',()=> socket.isAlive=true);
  clients.add(socket);
  sendWS(socket, JSON.stringify({type:'hello', mapSize: MAP_SIZE, orbs: state.orbs}));
  socket.on('data', buf=> handleWSData(socket, buf));
  socket.on('close',()=> cleanup(socket));
  socket.on('end',()=> cleanup(socket));
  socket.on('error',()=> cleanup(socket));
});

function sendWS(socket, dataStr){
  const data = Buffer.from(dataStr); const len = data.length;
  let header;
  if (len<126){ header = Buffer.from([0x81,len]); }
  else if (len<65536){ header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else { header=Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  try { socket.write(Buffer.concat([header, data])); } catch(e){}
}
function broadcast(obj){
  const s = JSON.stringify(obj);
  for(const c of clients) sendWS(c, s);
}
function cleanup(socket){
  if (!clients.has(socket)) return;
  const id = state.sockets.get(socket);
  clients.delete(socket);
  if (id && state.players.has(id)){
    state.players.delete(id);
    broadcast({type:'despawn', id});
  }
  state.sockets.delete(socket);
  try{ socket.destroy(); }catch(e){}
}
function parseFrame(buffer){
  const first = buffer[0]; const op = first & 0x0f;
  const second = buffer[1]; const masked = (second & 0x80)===0x80;
  let len = second & 0x7f; let off = 2;
  if (len===126){ len = buffer.readUInt16BE(off); off+=2; }
  else if (len===127){ len = Number(buffer.readBigUInt64BE(off)); off+=8; }
  let mask=null;
  if (masked){ mask=buffer.slice(off,off+4); off+=4; }
  let payload = buffer.slice(off, off+len);
  if (masked){ for(let i=0;i<payload.length;i++){ payload[i]^=mask[i%4]; } }
  return {op, payload: payload.toString('utf8')};
}
function handleWSData(socket, buffer){
  const frame = parseFrame(buffer);
  if (frame.op===0x8){ cleanup(socket); return; }
  if (frame.op!==0x1) return;
  let msg; try{ msg = JSON.parse(frame.payload); }catch(e){ return; }

  if (msg.type==='join'){
    if (state.players.size>=MAX_PLAYERS){ sendWS(socket, JSON.stringify({type:'reject', reason:'full'})); return; }
    const id = crypto.randomBytes(4).toString('hex');
    const name = (msg.name||'Player').slice(0,16);
    const avatar = ['cat','robot','packet'].includes(msg.avatar) ? msg.avatar : 'packet';
    const p = {
      id, name, avatar,
      x: rand(60, MAP_SIZE-60), y: rand(60, MAP_SIZE-60),
      dir: Math.random()*Math.PI*2, spd: 2.4,
      score: 0, alive: true, deadUntil: 0,
      trail: [] // array of points for collision (server side)
    };
    state.players.set(id, p);
    state.sockets.set(socket, id);
    sendWS(socket, JSON.stringify({type:'welcome', id, mapSize: MAP_SIZE, players: Array.from(state.players.values()).map(slim), orbs: state.orbs}));
    broadcast({type:'spawn', player: slim(p)});
  }
  else if (msg.type==='input'){
    const id = state.sockets.get(socket); if (!id) return;
    const p = state.players.get(id); if (!p) return;
    // WASD or mouse angle
    if (typeof msg.dir === 'number'){ p.dir = msg.dir; }
    if (typeof msg.boost === 'boolean'){ p.spd = msg.boost ? 3.2 : 2.4; }
  }
  else if (msg.type==='admin'){
    if (msg.action==='reset'){
      // wipe orbs and respawn
      state.orbs = [];
      spawnOrbs(ORB_COUNT);
      for (const p of state.players.values()){
        respawn(p, true);
      }
      broadcast({type:'reset', orbs: state.orbs, players: Array.from(state.players.values()).map(slim)});
    } else if (msg.action==='set' && msg.mapSize){
      // not resizing live for simplicity; requires restart to apply globally
    }
  }
}

function slim(p){
  return {id:p.id,name:p.name,avatar:p.avatar,x:p.x,y:p.y,score:p.score,alive:p.alive};
}

function lengthForScore(score){
  // how long the light trail is (server keeps last N points)
  return 30 + Math.min(120, Math.floor(score*2));
}

function respawn(p, hard){
  p.x = rand(60, MAP_SIZE-60); p.y = rand(60, MAP_SIZE-60);
  p.dir = Math.random()*Math.PI*2; p.spd = 2.4;
  p.score = hard ? 0 : 0;
  p.trail.length = 0;
  p.alive = true; p.deadUntil = 0;
}

function die(p, reason){
  if (!p.alive) return;
  p.alive = false;
  p.deadUntil = now() + RESPAWN_DELAY;
  broadcast({type:'death', id: p.id});
}

// Distance squared
function d2(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return dx*dx+dy*dy; }

// Main tick
setInterval(()=>{
  const t = now();
  // move players
  for (const p of state.players.values()){
    if (!p.alive){
      if (t >= p.deadUntil){
        respawn(p, true);
        broadcast({type:'spawn', player: slim(p)});
      }
      continue;
    }
    // movement
    p.x += Math.cos(p.dir)*p.spd;
    p.y += Math.sin(p.dir)*p.spd;

    // walls
    if (p.x<10 || p.y<10 || p.x>MAP_SIZE-10 || p.y>MAP_SIZE-10){
      die(p,'wall'); continue;
    }

    // trail update
    p.trail.push({x:p.x, y:p.y, t});
    const need = lengthForScore(p.score);
    if (p.trail.length > need) p.trail.splice(0, p.trail.length-need);

    // collect orbs
    for (let i=state.orbs.length-1;i>=0;i--){
      const o = state.orbs[i];
      if (d2(p,o) < 22*22){
        state.orbs.splice(i,1);
        state.orbs.push({x: rand(40, MAP_SIZE-40), y: rand(40, MAP_SIZE-40)});
        p.score += 1;
        broadcast({type:'orb', id:p.id, score:p.score, remove:i, add: state.orbs[state.orbs.length-1]});
      }
    }
  }

  // collision: head vs trails of others (and own, with small ignore to avoid instant death)
  for (const a of state.players.values()){
    if (!a.alive) continue;
    const head = {x:a.x, y:a.y};
    for (const b of state.players.values()){
      if (a.id===b.id && b.trail.length>10){
        // self collision: check older points excluding last 10
        for (let i=0;i<b.trail.length-12;i+=3){
          const pt = b.trail[i];
          if (d2(head, pt) < 12*12){ die(a,'self'); break; }
        }
        continue;
      }
      if (a.id===b.id) continue;
      for (let i=0;i<b.trail.length; i+=3){
        const pt = b.trail[i];
        if (d2(head, pt) < 12*12){ die(a,'hit'); break; }
      }
      if (!a.alive) break;
    }
  }

  // broadcast compact state (positions & scores)
  const snap = [];
  for (const p of state.players.values()){
    snap.push({id:p.id,x:p.x,y:p.y,score:p.score,alive:p.alive});
  }
  broadcast({type:'state', players: snap});
}, 1000/TICKRATE);

// Heartbeat
setInterval(()=>{
  for(const s of clients){
    try {
      const ping = Buffer.from([0x89,0x00]); s.write(ping);
    } catch(e){}
  }
}, 15000);

server.listen(PORT,'0.0.0.0', ()=>{
  console.log(`[VLAN-RUSH V2] Listening on 0.0.0.0:${PORT}`);
});
