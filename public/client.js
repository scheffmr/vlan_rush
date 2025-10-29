// VLAN-Rush V5.5 — static background canvas + client perf tweaks
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: true });
const sb = document.getElementById("scoreboard");

let ws, myId=null, mapSize=2000;
let lBase=30, lGrow=3;
let segmentPerPoint=3, segmentOverlap=0.25, emojiPx=22;

const players = new Map();
let orbs = [];
let pulse = 0;

// ---------- scoreboard ----------
let lastScoreRender = 0;
let lastScoreHTML = '';

// ---------- sprite cache ----------
const emojiSprites = new Map();

// ---------- audio ----------
let audioCtx;

// ---------- Caching-System ----------
const trailCache = new Map();
let frameCounter = 0;

// ---------- static background (grid + border) ----------
let bgCanvas = null;
let bgCtx = null;
let bgBuiltFor = { mapSize: null, gridStep: null };

// Step für Grid (gleich wie bisher)
const GRID_STEP = 100;


// ============== FUNKTIONEN ==============
// ---------- Offscreen-Background-Canvas ----------
function rebuildBackground(){
  // Wenn mapSize noch nicht bekannt ist, später erneut versuchen
  if (!mapSize || mapSize <= 0) return;

  // Neues Offscreen-Canvas anlegen, Größe = gesamte Map
  if (!bgCanvas) {
    bgCanvas = document.createElement('canvas');
    bgCtx = bgCanvas.getContext('2d');
  }
  // Nur neu aufbauen, wenn sich relevante Parameter geändert haben
  if (bgBuiltFor.mapSize === mapSize && bgBuiltFor.gridStep === GRID_STEP) return;

  bgCanvas.width = mapSize;
  bgCanvas.height = mapSize;

  // Hintergrund füllen (gleich wie Spielfeldfarbe)
  // (Das Game-Canvas hat #070a15 als Hintergrund – wir zeichnen denselben Farbton, damit es nahtlos ist)
  bgCtx.save();
  bgCtx.fillStyle = '#070a15';
  bgCtx.fillRect(0, 0, mapSize, mapSize);
  bgCtx.restore();

  // Grid zeichnen
  bgCtx.save();
  // dünne, subtile Linien wie im bisherigen Code (globalAlpha ~ 0.12)
  bgCtx.globalAlpha = 0.12;
  bgCtx.fillStyle = '#ffffff';
  // Vertikale Linien
  for (let x = 0; x < mapSize; x += GRID_STEP) {
    bgCtx.fillRect(x, 0, 1, mapSize);
  }
  // Horizontale Linien
  for (let y = 0; y < mapSize; y += GRID_STEP) {
    bgCtx.fillRect(0, y, mapSize, 1);
  }
  bgCtx.restore();

  // Border zeichnen (wie bisher)
  bgCtx.save();
  bgCtx.strokeStyle = '#4e0a9bff';
  bgCtx.lineWidth = 1;
  bgCtx.strokeRect(0.5, 0.5, mapSize - 1, mapSize - 1); // 0.5 für crisp line
  bgCtx.restore();

  bgBuiltFor = { mapSize, gridStep: GRID_STEP };
}


// ---------- audio ----------
function playBeep(freq=440, dur=0.08, type="sine"){
  try{
    if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.start(); o.stop(audioCtx.currentTime + dur);
  }catch(e){}
}

// ---------- sprite cache ----------
 function createEmojiSprite(emoji, size = emojiPx) {
  // 1) Groß auf temporäres Canvas zeichnen, damit wir eng croppen können
  const minVis = 32;
  const drawSize = Math.max(size, minVis);
  const tmp = document.createElement('canvas');
  // großzügig > genug Platz für alle Emojis/Fonts
  tmp.width = drawSize * 3;
  tmp.height = drawSize * 3;
  const tctx = tmp.getContext('2d');
  tctx.textAlign = 'center';
  tctx.textBaseline = 'middle';
  tctx.font = `${drawSize}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
  // mittig setzen
  const cx = tmp.width / 2, cy = tmp.height / 2;
  tctx.fillText(emoji, cx, cy);

  // 2) Alpha-Bounds finden (engster umschließender Rahmen)
  const img = tctx.getImageData(0, 0, tmp.width, tmp.height);
  const data = img.data;
  let minX = tmp.width, minY = tmp.height, maxX = 0, maxY = 0;
  for (let y = 0; y < tmp.height; y++) {
    for (let x = 0; x < tmp.width; x++) {
      const a = data[(y * tmp.width + x) * 4 + 3];
      if (a > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  // Falls das Emoji extrem klein wäre (sollte nicht vorkommen), fallback
  if (maxX <= minX || maxY <= minY) {
    return tmp;
  }
  
  // 3) Quadratisch croppen + kleines Padding für saubere Ränder
  const pad = Math.ceil(drawSize * 0.06); // ~6% Rand
  let boxW = (maxX - minX + 1) + pad * 2;
  let boxH = (maxY - minY + 1) + pad * 2;
  const box = Math.max(boxW, boxH); // quadratisch, damit Rotation sauber bleibt

  const out = document.createElement('canvas');
  out.width = box;
  out.height = box;
  const octx = out.getContext('2d');
  // Zielzentrum
  const ox = out.width / 2;
  const oy = out.height / 2;
  // Quelle: gecroppter Bereich
  const srcW = maxX - minX + 1;
  const srcH = maxY - minY + 1;
  // Quelle mittig in Ziel legen, dabei leicht herunterskalieren/hochskalieren, sodass die kurze Seite in den Box-Quadrat passt
  const scale = Math.min((box - 2 * pad) / srcW, (box - 2 * pad) / srcH);
  const dstW = Math.round(srcW * scale);
  const dstH = Math.round(srcH * scale);
  octx.drawImage(
    tmp,
    minX, minY, srcW, srcH,
    Math.round(ox - dstW / 2), Math.round(oy - dstH / 2), dstW, dstH
  );
  return out;
 }
function ensureSprite(emoji, size = emojiPx) {
  const key = `${emoji}_${size}`;
  if (!emojiSprites.has(key)) {
    emojiSprites.set(key, createEmojiSprite(emoji, size));
  }
  return emojiSprites.get(key);
}

// ---------- websocket ----------
const host = location.hostname || "Unbekannt";
connectWS(()=> send({type:'auto', host}));

function connectWS(onOpen){
  const url = (location.protocol==='https:'?'wss://':'ws://') + location.host;
  ws = new WebSocket(url);
  ws.onopen = ()=> onOpen && onOpen();
  ws.onclose = ()=> setTimeout(()=> connectWS(onOpen), 1000);
  ws.onmessage = onMessage;
}
function send(o){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function applyConfig(cfg){
  if (typeof cfg.lBase === 'number') lBase = cfg.lBase;
  if (typeof cfg.lGrow === 'number') lGrow = cfg.lGrow;
  if (typeof cfg.segmentPerPoint === 'number') segmentPerPoint = cfg.segmentPerPoint;
  if (typeof cfg.segmentOverlap === 'number') segmentOverlap = cfg.segmentOverlap;
  if (typeof cfg.emojiPx === 'number') emojiPx = cfg.emojiPx;
  emojiPx = Math.max(emojiPx, 22);
}

// ---------- messages ----------
function onMessage(ev){
  const msg = JSON.parse(ev.data);

  if (msg.type==='hello' || msg.type==='welcome'){
    mapSize = msg.mapSize; 
    orbs = msg.orbs || [];
    if (msg.players){
      msg.players.forEach(p => {
        players.set(p.id, {
          id: p.id, name: p.name, avatar: p.avatar,
          x: p.x, y: p.y, score: p.score, alive: p.alive,
          trail: Array.isArray(p.trail) ? p.trail.slice() : [],
          hitbox: p.hitbox || 6, boosting: !!p.boosting
        });
      });
    }
    if (msg.config) applyConfig(msg.config);
    if (msg.id) myId = msg.id;

    // sobald mapSize bekannt ist, Hintergrund erzeugen
    rebuildBackground();
  }
  else if (msg.type==='spawn'){
    players.set(msg.player.id, {...msg.player, trail: Array.isArray(msg.player.trail)? msg.player.trail.slice():[]});
  }
  else if (msg.type==='despawn'){
    players.delete(msg.id);
  }
  else if (msg.type==='death'){
    const p = players.get(msg.id);
    if (p){ p.alive=false; p.trail.length=0; if (p.id===myId) playBeep(200,0.12,'sawtooth'); }
  }
  else if (msg.type==='orbs'){
    orbs = msg.orbs || [];
    const p = players.get(msg.id);
    if (p){ p.score = msg.score; if (p.id===myId) playBeep(880,0.06,'square'); }
  }
  else if (msg.type==='reset'){
    players.clear();
    msg.players.forEach(p=> players.set(p.id, {...p, trail: Array.isArray(p.trail)? p.trail.slice():[] }));
    orbs = msg.orbs || [];
    // Map könnte sich geändert haben — sicherheitshalber neu bauen
    if (typeof msg.mapSize === 'number') mapSize = msg.mapSize;
    rebuildBackground();
  }
  else if (msg.type==='state'){
    if (msg.config) applyConfig(msg.config);
    msg.players.forEach(s=>{
      let p = players.get(s.id);
      if (!p){
        p = {id:s.id, name:s.name, avatar:s.avatar, trail:[]};
        players.set(s.id,p);
      }
      p.x = s.x; p.y = s.y; p.score = s.score; p.alive = s.alive;
      p.avatar = s.avatar; p.name = s.name; p.boosting = !!s.boosting;
      p.hitbox = s.hitbox;
      if (s.alive){
        p.trail.push({x:s.x, y:s.y, t:performance.now(), score:s.score});
        const keep = Math.max(lBase, lBase + s.score * lGrow);
        if (p.trail.length > keep) p.trail.splice(0, p.trail.length - keep);
      }
    });
  }
  else if (msg.type === 'delta') {
    msg.players.forEach(s => {
      let p = players.get(s.id);
      if (!p) {
        p = { id:s.id, name:'?', avatar:'❓', trail:[], alive:true, score:0 };
        players.set(s.id, p);
      }
      p.x = s.x; p.y = s.y;
      p.score = s.score; p.alive = s.alive;
      p.boosting = !!s.boosting;
      p.hitbox = s.hitbox;

      if (p.alive){
        p.trail.push({x:s.x, y:s.y, t:performance.now(), score:s.score});
        const keep = Math.max(lBase, lBase + s.score * lGrow);
        if (p.trail.length > keep) p.trail.splice(0, p.trail.length - keep);
      } else {
        p.trail.length = 0;
      }
    });
  }
}

// ---------- input ----------
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
  if (myId && players.has(myId)){
    const dx = (keys['KeyD']?1:0) - (keys['KeyA']?1:0);
    const dy = (keys['KeyS']?1:0) - (keys['KeyW']?1:0);
    if (dx||dy) send({type:'input', dir: Math.atan2(dy, dx)});
    send({type:'input', boost: !!keys['ShiftLeft'] || !!keys['ShiftRight']});
  }
  pulse += dt * 6;
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- camera ----------
function camera(){
  const w=canvas.width, h=canvas.height;
  if (!myId || !players.has(myId)) return {x: mapSize/2 - w/2, y: mapSize/2 - h/2};
  const me = players.get(myId);
  let x = me.x - w/2, y = me.y - h/2;
  x = Math.max(0, Math.min(mapSize - w, x));
  y = Math.max(0, Math.min(mapSize - h, y));
  return {x,y};
}

// ---------- draw ----------
function draw(){
  const w = canvas.width, h = canvas.height;
  const cam = camera();

  // 1) Hintergrund als Ausschnitt des Offscreen-Canvas zeichnen
  if (bgCanvas) {
    // Quelle: cam.x, cam.y, w, h | Ziel: 0,0,w,h
    ctx.drawImage(bgCanvas, cam.x, cam.y, w, h, 0, 0, w, h);
  } else {
    // Fallback (sollte nicht oft passieren)
    ctx.fillStyle = '#070a15';
    ctx.fillRect(0,0,w,h);
  }

  // sichtbarer Weltbereich +15 % Rand für Culling
  const margin = 0.15;
  const viewW = w * (1 + margin);
  const viewH = h * (1 + margin);
  const vx1 = cam.x - w * margin * 0.5;
  const vy1 = cam.y - h * margin * 0.5;
  const vx2 = cam.x + viewW;
  const vy2 = cam.y + viewH;

  // --- Orbs (nur sichtbare) ---
  for (const o of orbs){
    if (o.x < vx1 || o.x > vx2 || o.y < vy1 || o.y > vy2) continue;
    ctx.fillStyle = 'rgba(122,162,247,0.22)';
    ctx.beginPath(); ctx.arc(o.x-cam.x, o.y-cam.y, 12, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = o.bonus ? '#FFD700' : '#7aa2f7';
    ctx.beginPath(); ctx.arc(o.x-cam.x, o.y-cam.y, 6, 0, Math.PI*2); ctx.fill();
  }

  // --- Spieler & Trails ---
    // --- Spieler & Trails ---
  frameCounter++;
  for (const p of players.values()){
    if (!p.alive) continue;

    // Sichtbarkeit (Viewport + 15% Rand)
    const headInView = (p.x > vx1 && p.x < vx2 && p.y > vy1 && p.y < vy2);

    // Basismetriken für Größe — respektiere emojiPx (Config-Mindestgröße)
    const radiusBase = Math.max(p.hitbox || emojiPx, emojiPx); // FIX min snake size
    const segSize = radiusBase;                                 // FIX min snake size

    // -------- Trail nur zeichnen, wenn vorhanden --------
    const hasTrail = p.trail && p.trail.length >= 2;
    if (hasTrail) {
      // Kopfposition prüfen – wenn Kopf UND letztes Trailende komplett außerhalb liegen, Trail überspringen
      const lastSeg = p.trail[p.trail.length - 1];
      if (!headInView) {
        if (lastSeg.x < vx1 || lastSeg.x > vx2 || lastSeg.y < vy1 || lastSeg.y > vy2) {
          // kein Trail zeichnen, aber Kopf kann unten trotzdem gezeichnet werden
        } else {
          // Trail zeichnen
          const count = Math.max(0, Math.floor(p.score / segmentPerPoint));
          if (count > 0) {
            const overlap = Math.min(0.9, Math.max(0, segmentOverlap));
            const spacing = radiusBase * (1 - overlap); // FIX min snake size
            const EPS = 1e-4; // verhindert, dass ein Trail-Punkt exakt auf der Kopf-Position liegt

            // Trail-Cache verwenden
            let cache = trailCache.get(p.id);
            if (!cache) cache = { pts: [], lastFrame: 0 };
            const shouldRecalc = (frameCounter - cache.lastFrame) > 3;
            let pts;

            if (shouldRecalc) {
              pts = [];
              let need = spacing;
              for (let i = p.trail.length - 1; i > 0 && pts.length < count; i--) {
                const a = p.trail[i], b = p.trail[i - 1];
                const dx = a.x - b.x, dy = a.y - b.y;
                const segLen = Math.hypot(dx, dy); if (segLen <= 0) continue;
                while (need < segLen - EPS && pts.length < count) { // <— strikt unter segLen
                  const t = 1 - (need / segLen);
                  const x = a.x + (b.x - a.x) * t;
                  const y = a.y + (b.y - a.y) * t;
                  const dir = Math.atan2(a.y - b.y, a.x - b.x);
                  pts.push({ x, y, dir });
                  need += spacing;
                }
                need -= segLen;
              }
              cache.pts = pts;
              cache.lastFrame = frameCounter;
            } else {
              pts = cache.pts.slice();
            }
            trailCache.set(p.id, cache);

            const sprite = ensureSprite(p.avatar, segSize);
            ctx.globalAlpha = 1.0;
            const pxMargin = 0.15 * Math.max(w, h); // 15% Rand in Pixeln
            for (let i = pts.length - 1; i >= 0; i--) {
              const s = pts[i];
              if (s.x < vx1 - pxMargin || s.x > vx2 + pxMargin || s.y < vy1 - pxMargin || s.y > vy2 + pxMargin) continue;
              const sx = s.x - cam.x, sy = s.y - cam.y;
              ctx.save();
              ctx.translate(sx, sy);
              ctx.rotate(s.dir);
              ctx.drawImage(sprite, -segSize / 2, -segSize / 2, segSize, segSize);
              ctx.restore();
            }
          }
        }
      } else {
        // Kopf im View: Trail zeichnen (wie im anderen Zweig)
        const count = Math.max(0, Math.floor(p.score / segmentPerPoint));
        if (count > 0) {
          const overlap = Math.min(0.9, Math.max(0, segmentOverlap));
          const spacing = emojiPx * (1 - overlap); // spacing strikt an emojiPx koppeln (entspricht Server / Config)
          const EPS = 1e-4; // kein Punkt exakt auf Kopf-Position

          let cache = trailCache.get(p.id);
          if (!cache) cache = { pts: [], lastFrame: 0 };
          const shouldRecalc = (frameCounter - cache.lastFrame) > 3;
          let pts;

          if (shouldRecalc) {
            pts = [];
            let need = spacing;
            for (let i = p.trail.length - 1; i > 0 && pts.length < count; i--) {
              const a = p.trail[i], b = p.trail[i - 1];
              const dx = a.x - b.x, dy = a.y - b.y;
              const segLen = Math.hypot(dx, dy); if (segLen <= 0) continue;

              // WICHTIG: nie t=0 erzeugen (dann wäre Punkt auf 'a' = Kopfsegment)
              while (need < segLen - EPS && pts.length < count) {
                const t = 1 - (need / segLen);
                const x = a.x + (b.x - a.x) * t;
                const y = a.y + (b.y - a.y) * t;
                const dir = Math.atan2(a.y - b.y, a.x - b.x);
                // KEIN CULLING HIER – erst beim Zeichnen
                pts.push({ x, y, dir });
                need += spacing;
              }
              need -= segLen;
            }
            cache.pts = pts;
            cache.lastFrame = frameCounter;
          } else {
            pts = cache.pts.slice();
          }
          trailCache.set(p.id, cache);

          const sprite = ensureSprite(p.avatar, segSize);

          // Alpha zurücksetzen + einheitliches Culling beim Zeichnen
          ctx.globalAlpha = 1.0;
          const pxMargin = 0.15 * Math.max(w, h); // 15% Rand in Pixeln
          for (let i = pts.length - 1; i >= 0; i--) { // NICHTS überspringen
            const s = pts[i];
            if (s.x < vx1 - pxMargin || s.x > vx2 + pxMargin || s.y < vy1 - pxMargin || s.y > vy2 + pxMargin) continue;

            const sx = s.x - cam.x, sy = s.y - cam.y;
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(s.dir);
            ctx.drawImage(sprite, -segSize / 2, -segSize / 2, segSize, segSize);
            ctx.restore();
          }
        }
      }
    }

    // -------- Kopf IMMER zeichnen (auch ohne Trail) --------
    if (headInView) {
      let dir = 0;
      if (hasTrail){
        const a=p.trail[p.trail.length-1], b=p.trail[p.trail.length-2];
        dir = Math.atan2(a.y-b.y, a.x-b.x);
      }
      const x = p.x - cam.x, y = p.y - cam.y;
      ctx.save();
      ctx.translate(x,y);
      ctx.rotate(dir);
      if (p.boosting){ ctx.shadowColor="rgba(255,50,50,0.9)"; ctx.shadowBlur=20; }
      const spriteHead = ensureSprite(p.avatar, segSize);
      ctx.drawImage(spriteHead, -segSize/2, -segSize/2, segSize, segSize); // FIX min snake size
      ctx.restore();

      ctx.font = '12px system-ui';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(`${p.name} (${Math.floor(p.score)})`, x, y - segSize * 0.6);
    }
  }

  // --- Scoreboard ---
  renderScoreboard();
}

// ---------- scoreboard ----------
function renderScoreboard() {
  if (!sb) return;
  const now = performance.now();

  if (now - lastScoreRender < 500) return;
  lastScoreRender = now;

  const list = Array.from(players.values())
    .filter(p => p.alive)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  let html;
  if (!list.length) {
    html = `<div class="score-title">Punkte</div><div class="score-empty">Noch keine Spieler aktiv</div>`;
  } else {
    const rows = list.map((p, idx) =>
      `<div class="scoreitem"><span class="name">${idx + 1}. ${esc(p.name)}</span><span class="points">${Math.floor(p.score)}</span></div>`
    ).join('');
    html = `<div class="score-title">Punkte</div>${rows}`;
  }

  if (html !== lastScoreHTML) {
    sb.innerHTML = html;
    lastScoreHTML = html;
  }
}

function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }


// ============== EVENT LISTENER ==============
function resize(){ 
  canvas.width = window.innerWidth; 
  canvas.height = window.innerHeight; 
  // Hintergrund bei Resize neu generieren (gewünscht)
  rebuildBackground();
}
window.addEventListener("resize", resize); 
resize();