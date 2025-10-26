
/**
 * LAN Rush — VLAN Edition
 * Minimal HTTP + WebSocket server with no external dependencies.
 * Node 18+ recommended.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load config
const cfgPath = path.join(__dirname, 'config.json');
let CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
const MODE = (process.env.MODE || 'collect').toLowerCase(); // collect | ctf | king

const PORT = Number(process.env.PORT || CFG.port || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

// In-memory game state
const state = {
  mode: MODE,                       // current mode
  players: new Map(),               // id -> player
  sockets: new Map(),               // socket -> id
  pellets: [],                      // for collect mode
  flags: {},                        // for ctf
  hill: null,                       // for king
  round: {
    startedAt: 0,
    timeLimitSec: CFG.round?.timeLimitSec ?? 300,
    scoreLimit: CFG.round?.scoreLimit ?? 50,
    running: false
  },
  mapSize: CFG.round?.mapSize ?? 1600
};

// Utility
function rand(min, max){ return Math.floor(Math.random()*(max-min+1))+min; }
function now(){ return Date.now(); }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

// Static file server
function sendFile(res, filePath){
  fs.readFile(filePath, (err, data)=>{
    if(err){
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
}

const server = http.createServer((req, res)=>{
  // Simple routes
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  if (url === '/spectator') url = '/spectator.html';
  const filePath = path.join(__dirname, 'public', url);
  if (filePath.indexOf(path.join(__dirname, 'public')) !== 0){
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat)=>{
    if(err || !stat.isFile()){
      res.writeHead(404); res.end('Not found'); return;
    }
    sendFile(res, filePath);
  });
});

// --- Minimal WebSocket implementation (text frames only) ---
const clients = new Set();

server.on('upgrade', (req, socket, head)=>{
  if (req.headers['upgrade'] !== 'websocket'){
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const acceptKey = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];
  socket.write(headers.concat('\r\n').join('\r\n'));

  socket.isAlive = true;
  socket.on('pong', ()=> socket.isAlive = true);

  clients.add(socket);

  socket.on('data', (buffer)=>{
    // Parse WS frame (simplified: text frames, <=125 bytes payload common, also handle >125)
    const firstByte = buffer[0];
    const opCode = firstByte & 0x0f;
    if (opCode === 0x8){ // close
      cleanupSocket(socket);
      return;
    }
    const secondByte = buffer[1];
    const isMasked = (secondByte & 0x80) === 0x80;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;
    if (payloadLen === 126){
      payloadLen = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127){
      // Only support up to 2^32-1 here for simplicity
      payloadLen = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskingKey = null;
    if (isMasked){
      maskingKey = buffer.slice(offset, offset+4);
      offset += 4;
    }
    let payload = buffer.slice(offset, offset+payloadLen);
    if (isMasked){
      for (let i=0; i<payload.length; i++){
        payload[i] ^= maskingKey[i % 4];
      }
    }
    if (opCode === 0x1){ // text
      const text = payload.toString('utf8');
      handleMessage(socket, text);
    }
  });

  socket.on('close', ()=> cleanupSocket(socket));
  socket.on('end', ()=> cleanupSocket(socket));
  socket.on('error', ()=> cleanupSocket(socket));

  // Send hello
  sendWS(socket, JSON.stringify({type:'hello', mode: state.mode, mapSize: state.mapSize, round: state.round}));
});

function sendWS(socket, dataStr){
  // Text frame
  const data = Buffer.from(dataStr);
  const len = data.length;
  let header;
  if (len < 126){
    header = Buffer.from([0x81, len]);
  } else if (len < 65536){
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const frame = Buffer.concat([header, data]);
  try { socket.write(frame); } catch(e){ /* ignore */ }
}

function broadcast(obj){
  const data = JSON.stringify(obj);
  for (const s of clients){
    sendWS(s, data);
  }
}

function cleanupSocket(socket){
  if (!clients.has(socket)) return;
  const id = state.sockets.get(socket);
  clients.delete(socket);
  if (id && state.players.has(id)){
    state.players.delete(id);
    broadcast({type:'despawn', id});
  }
  state.sockets.delete(socket);
  try { socket.destroy(); } catch(e){}
}

// Game logic
function handleMessage(socket, text){
  let msg;
  try { msg = JSON.parse(text); } catch(e){ return; }

  if (msg.type === 'join'){
    if (state.players.size >= (CFG.maxPlayers || 20)){
      sendWS(socket, JSON.stringify({type:'reject', reason:'server_full'}));
      return;
    }
    const id = crypto.randomBytes(4).toString('hex');
    const name = (msg.name || 'Player').slice(0,16);
    const avatar = ['cat','robot','packet'].includes(msg.avatar) ? msg.avatar : 'packet';
    const px = rand(50, state.mapSize-50);
    const py = rand(50, state.mapSize-50);
    const player = {
      id, name, avatar,
      x: px, y: py,
      vx: 0, vy: 0,
      score: 0,
      lastSeen: now()
    };
    state.players.set(id, player);
    state.sockets.set(socket, id);

    // Send current world
    sendWS(socket, JSON.stringify({type:'welcome', id, players: Array.from(state.players.values()), pellets: state.pellets, flags: state.flags, hill: state.hill, round: state.round, mapSize: state.mapSize, mode: state.mode}));

    // Tell others
    broadcast({type:'spawn', player});

  } else if (msg.type === 'input'){
    // movement input from client
    const id = state.sockets.get(socket);
    if (!id) return;
    const p = state.players.get(id);
    if (!p) return;
    p.lastSeen = now();
    // Apply movement
    const speed = 3.0;
    p.x = clamp(p.x + (msg.dx||0)*speed, 0, state.mapSize);
    p.y = clamp(p.y + (msg.dy||0)*speed, 0, state.mapSize);

    // Pickups for 'collect'
    if (state.mode === 'collect' && state.round.running){
      for (let i=state.pellets.length-1; i>=0; i--){
        const t = state.pellets[i];
        const dx = p.x - t.x, dy = p.y - t.y;
        if (dx*dx + dy*dy < 20*20){
          state.pellets.splice(i,1);
          p.score += 1;
          broadcast({type:'pickup', id: p.id, pelletIndex: i, score: p.score});
          if (p.score >= state.round.scoreLimit){
            endRound(`Winner: ${p.name}`);
          }
        }
      }
    }

    // Periodically broadcast positions (lightweight)
    broadcast({type:'pos', id: p.id, x: p.x, y: p.y, s: p.score});

  } else if (msg.type === 'chat'){
    const id = state.sockets.get(socket);
    if (!id) return;
    const p = state.players.get(id);
    if (!p) return;
    const text = (msg.text || '').slice(0,120);
    if (!text) return;
    broadcast({type:'chat', id: p.id, name: p.name, text});
  } else if (msg.type === 'admin' && msg.action){
    // no auth in offline lab; keep simple
    if (msg.action === 'startRound'){
      startRound();
    } else if (msg.action === 'stopRound'){
      endRound('Stopped');
    } else if (msg.action === 'setMode'){
      const m = (msg.mode||'collect').toLowerCase();
      if (['collect','ctf','king'].includes(m)){
        state.mode = m;
        broadcast({type:'mode', mode: state.mode});
      }
    } else if (msg.action === 'setLimits'){
      if (typeof msg.scoreLimit === 'number') state.round.scoreLimit = msg.scoreLimit;
      if (typeof msg.timeLimitSec === 'number') state.round.timeLimitSec = msg.timeLimitSec;
      broadcast({type:'roundLimits', scoreLimit: state.round.scoreLimit, timeLimitSec: state.round.timeLimitSec});
    }
  }
}

function startRound(){
  // Reset scores
  for (const p of state.players.values()){ p.score = 0; }
  // Spawn pellets for 'collect'
  if (state.mode === 'collect'){
    state.pellets = [];
    const count = 80;
    for (let i=0; i<count; i++){
      state.pellets.push({x: rand(30, state.mapSize-30), y: rand(30, state.mapSize-30)});
    }
  }
  // Minimal placeholders for other modes (ctf/king)
  if (state.mode === 'ctf'){
    state.flags = {
      A: {x: rand(100, 200), y: rand(100, 200)},
      B: {x: rand(state.mapSize-200, state.mapSize-100), y: rand(state.mapSize-200, state.mapSize-100)}
    };
  }
  if (state.mode === 'king'){
    state.hill = {x: state.mapSize/2, y: state.mapSize/2, r: 120};
  }
  state.round.running = true;
  state.round.startedAt = now();
  broadcast({type:'roundStart', mode: state.mode, pellets: state.pellets, flags: state.flags, hill: state.hill, round: state.round});
  // Timer
  if (state.round.timeLimitSec > 0){
    setTimeout(()=>{
      if (state.round.running){
        // Determine winner by score
        let winner = null;
        for (const p of state.players.values()){
          if (!winner || p.score > winner.score) winner = p;
        }
        endRound(winner ? `Time! Winner: ${winner.name}` : 'Time!');
      }
    }, state.round.timeLimitSec * 1000);
  }
}

function endRound(reason){
  state.round.running = false;
  broadcast({type:'roundEnd', reason});
}

// Heartbeat ping
setInterval(()=>{
  for (const s of clients){
    try {
      s.isAlive = false;
      // send ping frame
      const ping = Buffer.from([0x89, 0x00]);
      s.write(ping);
      setTimeout(()=>{
        if (!s.isAlive) cleanupSocket(s);
      }, 10000);
    } catch(e){}
  }
}, 15000);

server.listen(PORT, '0.0.0.0', ()=>{
  console.log(`[LAN RUSH] Server listening on 0.0.0.0:${PORT} (mode=${state.mode})`);
});

// ---------------- PUBLIC FILES ----------------
