
// VLAN-Rush V4.1 — stable with HTTPS, avatar/orb fixes, circle hitbox
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf-8'));
const HTTP_PORT = cfg.http_port || 3000;
const HTTPS_PORT = cfg.https_port || 3443;
const MAP_SIZE = cfg.mapSize || 2000;
const MAX_PLAYERS = cfg.maxPlayers || 20;
const ORB_COUNT = cfg.orbCount || 160;
const TICKRATE = cfg.tickRate || 30;
const RESPAWN_DELAY = cfg.respawnDelayMs || 1500;
const HIT_R = cfg.hitRadius || 12;

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'
};

const state = { players: new Map(), sockets: new Map(), orbs: [] };

function rand(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function now(){ return Date.now(); }
function d2(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return dx*dx+dy*dy; }

function spawnOrbs(n){ for(let i=0;i<n;i++){ state.orbs.push({x:rand(40,MAP_SIZE-40),y:rand(40,MAP_SIZE-40)}); } }
spawnOrbs(ORB_COUNT);

// Static
function sendFile(res, fp){
  fs.readFile(fp,(err,data)=>{
    if(err){ res.writeHead(404).end('Not found'); return; }
    const ext = path.extname(fp);
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
}
function route(req,res){
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const fp = path.join(__dirname,'public',url);
  if (!fp.startsWith(path.join(__dirname,'public'))){ res.writeHead(403).end('Forbidden'); return; }
  fs.stat(fp,(e,st)=> e||!st.isFile() ? res.writeHead(404).end('Not found') : sendFile(res,fp));
}

const httpServer = http.createServer(route);
const httpsServer = https.createServer({
  key: fs.readFileSync(path.join(__dirname,'key.pem')),
  cert: fs.readFileSync(path.join(__dirname,'cert.pem'))
}, route);

// Minimal WebSocket on both
const clients = new Set();
for (const server of [httpServer, httpsServer]){
  server.on('upgrade', (req, socket, head)=>{
    if (req.headers['upgrade'] !== 'websocket'){ socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const acceptKey = crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11','binary').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade',`Sec-WebSocket-Accept: ${acceptKey}`,'',''
    ].join('\r\n'));
    socket.isAlive = true; socket.on('pong',()=> socket.isAlive=true);
    clients.add(socket);
    sendWS(socket, JSON.stringify({type:'hello', mapSize: MAP_SIZE, orbs: state.orbs}));
    socket.on('data', buf=> handleWS(socket, buf));
    socket.on('close', ()=> cleanup(socket));
    socket.on('end', ()=> cleanup(socket));
    socket.on('error', ()=> cleanup(socket));
  });
}

function sendWS(socket, dataStr){
  const data = Buffer.from(dataStr); const len = data.length;
  let header;
  if (len<126){ header = Buffer.from([0x81,len]); }
  else if (len<65536){ header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else { header=Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  try{ socket.write(Buffer.concat([header,data])); }catch(e){}
}
function broadcast(obj){ const s = JSON.stringify(obj); for(const c of clients) sendWS(c,s); }
function cleanup(socket){
  if (!clients.has(socket)) return;
  const id = state.sockets.get(socket);
  clients.delete(socket);
  if (id && state.players.has(id)){ state.players.delete(id); broadcast({type:'despawn', id}); }
  state.sockets.delete(socket);
  try{ socket.destroy(); }catch(e){}
}
function parseWS(buf){
  const op = buf[0] & 0x0f; const masked = (buf[1] & 0x80)===0x80; let len = buf[1] & 0x7f; let off = 2;
  if (len===126){ len = buf.readUInt16BE(off); off+=2; } else if (len===127){ len = Number(buf.readBigUInt64BE(off)); off+=8; }
  let mask=null; if (masked){ mask=buf.slice(off,off+4); off+=4; }
  let payload = buf.slice(off, off+len); if (masked){ for(let i=0;i<payload.length;i++){ payload[i]^=mask[i%4]; } }
  return {op, text: payload.toString('utf8')};
}

function handleWS(socket, buffer){
  const fr = parseWS(buffer);
  if (fr.op===0x8){ cleanup(socket); return; }
  if (fr.op!==0x1) return;
  let msg; try{ msg = JSON.parse(fr.text); }catch(e){ return; }

  if (msg.type==='join'){
    if (state.players.size>=MAX_PLAYERS){ sendWS(socket, JSON.stringify({type:'reject',reason:'full'})); return; }
    const id = crypto.randomBytes(4).toString('hex');
    const name = (msg.name||'Player').slice(0,16);
    const avatar = ['cat','robot','packet'].includes(msg.avatar) ? msg.avatar : 'packet';
    const p = {
      id, name, avatar,
      x: rand(60, MAP_SIZE-60), y: rand(60, MAP_SIZE-60),
      dir: Math.random()*Math.PI*2, spd: 2.4,
      score: 0, alive: true, deadUntil: 0,
      trail: []
    };
    state.players.set(id, p);
    state.sockets.set(socket, id);
    sendWS(socket, JSON.stringify({type:'welcome', id, mapSize: MAP_SIZE, players: Array.from(state.players.values()).map(slim), orbs: state.orbs}));
    broadcast({type:'spawn', player: slim(p)});
  }
  else if (msg.type==='input'){
    const id = state.sockets.get(socket); if (!id) return;
    const p = state.players.get(id); if (!p) return;
    if (typeof msg.dir==='number') p.dir = msg.dir;
    if (typeof msg.boost==='boolean') p.spd = msg.boost ? 3.2 : 2.4;
  }
  else if (msg.type==='admin' && msg.action==='reset'){
    state.orbs = []; spawnOrbs(ORB_COUNT);
    for (const p of state.players.values()){ respawn(p); }
    broadcast({type:'reset', orbs: state.orbs, players: Array.from(state.players.values()).map(slim)});
  }
}

function slim(p){ return {id:p.id,name:p.name,avatar:p.avatar,x:p.x,y:p.y,score:p.score,alive:p.alive}; }
function respawn(p){
  p.x = rand(60, MAP_SIZE-60); p.y = rand(60, MAP_SIZE-60);
  p.dir = Math.random()*Math.PI*2; p.spd = 2.4; p.score = 0; p.trail.length = 0; p.alive = true; p.deadUntil = 0;
}
function die(p){ if (!p.alive) return; p.alive=false; p.deadUntil = now()+RESPAWN_DELAY; broadcast({type:'death', id:p.id}); }

// Growth helpers
function trailKeep(score){ return 120 + score*6; }
function trailWidth(score){ return 6 + Math.floor(score/5); }

setInterval(()=>{
  const t = now();
  for (const p of state.players.values()){
    if (!p.alive){
      if (t>=p.deadUntil){ respawn(p); broadcast({type:'spawn', player: slim(p)}); }
      continue;
    }
    p.x += Math.cos(p.dir)*p.spd;
    p.y += Math.sin(p.dir)*p.spd;

    // walls
    if (p.x<HIT_R || p.y<HIT_R || p.x>MAP_SIZE-HIT_R || p.y>MAP_SIZE-HIT_R){ die(p); continue; }

    // trail
    p.trail.push({x:p.x,y:p.y,t});
    const need = Math.floor(trailKeep(p.score));
    if (p.trail.length>need) p.trail.splice(0, p.trail.length-need);

    // orbs collect
    let changed = false;
    for (let i=state.orbs.length-1;i>=0;i--){
      const o = state.orbs[i];
      if (d2(p,o) < (HIT_R+6)*(HIT_R+6)){
        state.orbs.splice(i,1);
        changed = true;
        p.score += 1;
      }
    }
    // respawn missing orbs
    while (state.orbs.length < ORB_COUNT){
      state.orbs.push({x:rand(40,MAP_SIZE-40),y:rand(40,MAP_SIZE-40)});
      changed = true;
    }
    if (changed){
      // send full orblist + updated score of this player
      broadcast({type:'orbs', orbs: state.orbs, id:p.id, score:p.score});
    }
  }

  // Collisions: circle head vs trails (self + others)
  for (const a of state.players.values()){
    if (!a.alive) continue;
    const head = {x:a.x, y:a.y};
    // self: ignore last 12 points
    if (a.trail.length>12){
      for (let i=0;i<a.trail.length-12;i+=3){
        const pt = a.trail[i];
        const rad = HIT_R; // vs thin trail (use width based on own score? here only trail width matters)
        if (d2(head, pt) < (rad + trailWidth(a.score)/2)**2){ die(a); break; }
      }
      if (!a.alive) continue;
    }
    // others
    for (const b of state.players.values()){
      if (a.id===b.id) continue;
      const rad = HIT_R + trailWidth(b.score)/2;
      for (let i=0;i<b.trail.length;i+=3){
        const pt = b.trail[i];
        if (d2(head, pt) < rad*rad){ die(a); break; }
      }
      if (!a.alive) break;
    }
  }

  // snapshot (positions+avatars)
  const snap = [];
  for (const p of state.players.values()){
    snap.push({id:p.id,x:p.x,y:p.y,score:p.score,alive:p.alive,avatar:p.avatar});
  }
  broadcast({type:'state', players: snap});
}, 1000/TICKRATE);

// Heartbeat ping
setInterval(()=>{
  for (const s of clients){ try{ const ping = Buffer.from([0x89,0x00]); s.write(ping); }catch(e){} }
}, 15000);

httpServer.listen(HTTP_PORT,'0.0.0.0', ()=> console.log(`[VLAN-RUSH V4.1] HTTP on ${HTTP_PORT}`));
httpsServer.listen(HTTPS_PORT,'0.0.0.0', ()=> console.log(`[VLAN-RUSH V4.1] HTTPS on ${HTTPS_PORT}`));
