
// VLAN-Rush V4.3 — Emoji avatars, scoreboard, HTTPS
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

const EMOJIS = ['🐱','🤖','📦','🖧','💻','🐶','🐭','🚀','🐸','😎'];

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'
};

const state = { players: new Map(), sockets: new Map(), orbs: [] };

function rand(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function now(){ return Date.now(); }
function d2xy(ax,ay,bx,by){ const dx=ax-bx, dy=ay-by; return dx*dx+dy*dy; }
function cleanIP(remoteAddress){
  if (!remoteAddress) return '0.0.0.0';
  // strip IPv6 prefix like ::ffff:
  const m = remoteAddress.match(/(?:\\d+\\.){3}\\d+/);
  return m ? m[0] : remoteAddress;
}
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }

// Segment-Hilfsfunktion: gleichmäßige Punkte entlang der Spur
function sampleSegmentsFromTrail(trail, spacing, maxCount){
  const out = [];
  if (!trail || trail.length < 2 || spacing <= 0 || maxCount <= 0) return out;

  // vom Ende (aktuelles Ende = Kopf) rückwärts integrieren
  let need = spacing;
  for (let i = trail.length-1; i > 0 && out.length < maxCount; i--){
    const a = trail[i], b = trail[i-1];
    const segLen = dist(a,b);
    if (segLen <= 0) continue;

    // Lauf entlang [a->b] rückwärts in Abständen von 'need'
    while (need <= segLen && out.length < maxCount) {
      const t = 1 - (need / segLen);            // Anteil Richtung a
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      out.push({ x: px, y: py });
      need += spacing;
    }
    need -= segLen;
  }
  return out;
}

function spawnOrbs(n){ for(let i=0;i<n;i++){ state.orbs.push({x:rand(40,MAP_SIZE-40),y:rand(40,MAP_SIZE-40)}); } }
spawnOrbs(ORB_COUNT);

// Static routing
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
    const ip = cleanIP(req.socket.remoteAddress);
    sendWS(socket, JSON.stringify({
	  type:'hello',
	  mapSize: MAP_SIZE,
	  orbs: state.orbs,
          config: {
                wBase: cfg.trailWidthBase, wGrow: cfg.trailWidthGrowth,
                lBase: cfg.trailLengthBase, lGrow: cfg.trailLengthGrowth,
                segmentPerPoint: cfg.segmentPerPoint,
                segmentOverlap: cfg.segmentOverlap,
                emojiPx: cfg.emojiPx,
                selfKill: cfg.selfHeadKillPercent,
                version: '4.7'
          }
	}));
    socket.on('data', buf=> handleWS(socket, buf, ip));
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

function handleWS(socket, buffer, ip){
  const fr = parseWS(buffer);
  if (fr.op===0x8){ cleanup(socket); return; }
  if (fr.op!==0x1) return;
  let msg; try{ msg = JSON.parse(fr.text); }catch(e){ return; }

  if (msg.type==='join' || msg.type==='auto'){
    if (state.players.size>=MAX_PLAYERS){ sendWS(socket, JSON.stringify({type:'reject',reason:'full'})); return; }
    const id = crypto.randomBytes(4).toString('hex');
    // random name from config
	const names = cfg.playerNames || ["Player"];
	let name;

	// get unique name
	if (!cfg._usedNames) cfg._usedNames = new Set();
	let idx = 0;
	while (idx < names.length) {
	  const tryName = names[rand(0, names.length-1)];
	  if (!cfg._usedNames.has(tryName)) {
		name = tryName;
		cfg._usedNames.add(tryName);
		break;
	  }
	  idx++;
	}

	// fallback wenn Namen ausgehen
	if (!name) {
	  name = `Player${state.players.size + 1}`;
	}

	const avatar = EMOJIS[rand(0, EMOJIS.length-1)];

	const p = {
      id, name, avatar, ip,
      x: rand(60, MAP_SIZE-60), y: rand(60, MAP_SIZE-60),
      dir: Math.random()*Math.PI*2, spd: 2.4,
      score: 0, alive: true, deadUntil: 0,
      trail: [], invulnUntil: 0, boostPenalty: 0
    };
    state.players.set(id, p);
    state.sockets.set(socket, id);
    sendWS(socket, JSON.stringify({
	  type:'welcome',
	  id,
	  mapSize: MAP_SIZE,
	  players: Array.from(state.players.values()).map(slim),
	  orbs: state.orbs,
          config: {
                wBase: cfg.trailWidthBase, wGrow: cfg.trailWidthGrowth,
                lBase: cfg.trailLengthBase, lGrow: cfg.trailLengthGrowth,
                segmentPerPoint: cfg.segmentPerPoint,
                segmentOverlap: cfg.segmentOverlap,
                emojiPx: cfg.emojiPx,
                selfKill: cfg.selfHeadKillPercent,
                version: '4.7'
          }
	}));
    broadcast({type:'spawn', player: slim(p)});
  }
  else if (msg.type==='input'){
    const id = state.sockets.get(socket); if (!id) return;
    const p = state.players.get(id); if (!p) return;
    if (typeof msg.dir==='number') p.dir = msg.dir;
    if (typeof msg.boost==='boolean') p.spd = msg.boost ? 3.2 : 2.4;
    p.boosting = !!msg.boost;
  }
  else if (msg.type==='admin' && msg.action==='reset'){
    state.orbs = []; spawnOrbs(ORB_COUNT);
    for (const p of state.players.values()){ respawn(p); }
    broadcast({type:'reset', orbs: state.orbs, players: Array.from(state.players.values()).map(slim)});
  }
}

function slim(p){ return {id:p.id,name:p.name,avatar:p.avatar,x:p.x,y:p.y,score:p.score,alive:p.alive,ip:p.ip}; }
function respawn(p){
  p.x = rand(60, MAP_SIZE-60); p.y = rand(60, MAP_SIZE-60);
  p.dir = Math.random()*Math.PI*2; p.spd = 2.4; p.score = 0; p.trail.length = 0; p.alive = true;
  p.deadUntil = 0; p.invulnUntil = now() + (cfg.respawnInvulnMs || 300);
  p.boostPenalty = 0;
}
function die(p){
  if (!p.alive) return;
  p.alive=false;
  const t = now();
  p.deadUntil = t + RESPAWN_DELAY;
  broadcast({type:'death', id:p.id});

  // ✅ Bonus orb logic
  const bonusCount = Math.min(5, Math.floor(p.score / 10));
  for (let i = 0; i < bonusCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 25 + Math.random() * 30;
    state.orbs.push({
      x: p.x + Math.cos(a) * d,
      y: p.y + Math.sin(a) * d,
      bonus: true,
      value: 5
    });
    // Bonus-Orbs sofort an alle Clients senden ✅
    broadcast({
      type:'orbs',
      orbs: state.orbs
    });
  }
}

// Trail helpers
function trailKeep(score, penalty){
  const base = (cfg.trailLengthBase ?? 30);
  const grow = (cfg.trailLengthGrowth ?? 3);
  return Math.max(base, base + score * grow - (penalty || 0));
}
function trailWidth(score){
  const base = (cfg.trailWidthBase ?? 6);
  const grow = (cfg.trailWidthGrowth ?? 0.03);
  return base + Math.floor(score * grow);
}
// Angle helpers
function angleBetween(ax,ay,bx,by,dir){
  const vx = bx-ax, vy = by-ay;
  let a = Math.atan2(vy, vx) - dir;
  while (a > Math.PI) a -= 2*Math.PI;
  while (a < -Math.PI) a += 2*Math.PI;
  return Math.abs(a) * 180/Math.PI; // degrees
}

setInterval(()=>{
  const t = now();
  for (const p of state.players.values()){
    if (!p.alive){
      if (t>=p.deadUntil){ respawn(p); broadcast({type:'spawn', player: slim(p)}); }
      continue;
    }
    // movement
    p.x += Math.cos(p.dir)*p.spd;
    p.y += Math.sin(p.dir)*p.spd;

    // boost penalty (temporary)
    if (p.boosting){ p.score = Math.max(0, p.score - 0.03); }

    // walls
    if (p.x < trailWidth(p.score)/2 || p.y < trailWidth(p.score)/2 || p.x > MAP_SIZE - trailWidth(p.score)/2 || p.y > MAP_SIZE - trailWidth(p.score)/2){
      if (t >= p.invulnUntil) die(p);
      continue;
    }

    // trail
    p.trail.push({x:p.x,y:p.y,t});
    const need = Math.floor(trailKeep(p.score, p.boostPenalty));
    if (p.trail.length>need) p.trail.splice(0, p.trail.length-need);

    // orbs collect
    let changed = false;
    for (let i=state.orbs.length-1;i>=0;i--){
      const o = state.orbs[i];
	  const rHead = trailWidth(p.score) / 2;
      if (d2xy(p.x,p.y,o.x,o.y) < (rHead + 6) * (rHead + 6)){
        state.orbs.splice(i,1);
        changed = true;
        if (o.bonus) {
        p.score += o.value || 5;
      } else {
        p.score += 1;
      }
      }
    }
    while (state.orbs.length < ORB_COUNT){ state.orbs.push({x:rand(40,MAP_SIZE-40),y:rand(40,MAP_SIZE-40)}); changed = true; }
    if (changed){ broadcast({type:'orbs', orbs: state.orbs, id:p.id, score:p.score}); }
  }

// collisions
for (const a of state.players.values()){
  if (!a.alive) continue;
  if (t < a.invulnUntil) continue;

  const head = { x: a.x, y: a.y };

  // SELF-COLLISION DISABLED: Eigene Spur ist harmlos
  // (kein Code für self-hit)

  // Andere Spieler: Head A kollidiert mit Segmentpunkten von B
  for (const b of state.players.values()){
    if (a.id === b.id || !b.alive) continue;

    // Segment-Anzahl: 1 Segment je segmentPerPoint Score
    const per = cfg.segmentPerPoint ?? 3;
    const segCount = Math.max(0, Math.floor(b.score / per));

    if (segCount > 0) {
      const emojiPx = cfg.emojiPx ?? 22;
      const overlap = Math.min(0.9, Math.max(0, cfg.segmentOverlap ?? 0.25));
      const spacing = emojiPx * (1 - overlap);          // Weltpixel-Abstand
      const radius = emojiPx * 0.5;                      // Kreis-Hitbox pro Segment

      // Punkte entlang der Spur von B ermitteln
      const segPts = sampleSegmentsFromTrail(b.trail, spacing, segCount);

      // Optional: Kopf von B zusätzlich als „Segment“
      segPts.push({ x: b.x, y: b.y });

      const r2 = (radius + radius) * (radius + radius);  // Head-Radius ~ radius
      for (const s of segPts){
        const dx = head.x - s.x, dy = head.y - s.y;
        if (dx*dx + dy*dy < r2){ die(a); break; }
      }
      if (!a.alive) break;
    }
  }
}


  // snapshot
	const snap = [];
	for (const p of state.players.values()){
		snap.push({
			id: p.id,
			x: p.x,
			y: p.y,
			score: p.score,
			alive: p.alive,
			avatar: p.avatar,
			name: p.name,
			ip: p.ip,
			boosting: p.boosting   // ✅ Boost-Flag übertragen
		});
	}
	broadcast({ type:'state', players: snap });
}, 1000/TICKRATE);

// Heartbeat
setInterval(()=>{ for (const s of clients){ try{ const ping=Buffer.from([0x89,0x00]); s.write(ping); }catch(e){} } }, 15000);

httpServer.listen(HTTP_PORT,'0.0.0.0', ()=> console.log(`[VLAN-RUSH V4.7] HTTP on ${HTTP_PORT}`));
httpsServer.listen(HTTPS_PORT,'0.0.0.0', ()=> console.log(`[VLAN-RUSH V4.7] HTTPS on ${HTTPS_PORT}`));

