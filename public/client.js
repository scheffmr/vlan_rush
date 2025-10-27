// VLAN-Rush V5.1 — server-synced hitbox client
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const sb = document.getElementById("scoreboard");
let renderScale = 4.0;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

let ws, myId = null, mapSize = 2000;
let wBase = 6, wGrow = 0.03, lBase = 30, lGrow = 3;
let segmentPerPoint = 3, segmentOverlap = 0.25, emojiPx = 22;

const players = new Map();
let orbs = [];
let pulse = 0;

// ====== AUDIO ======
let audioCtx;
function playBeep(freq = 440, dur = 0.08, type = "sine") {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (e) {}
}

// ====== WEBSOCKET ======
const host = location.hostname || "Unbekannt";
connectWS(() => send({ type: "auto", host }));

function connectWS(onOpen) {
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
  ws = new WebSocket(url);
  ws.onopen = () => onOpen && onOpen();
  ws.onclose = () => setTimeout(() => connectWS(onOpen), 1000);
  ws.onmessage = onMessage;
}
function send(o) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(o));
}

// ====== MESSAGE HANDLER ======
function onMessage(ev) {
  const msg = JSON.parse(ev.data);
  if (msg.type === "hello" || msg.type === "welcome") {
    mapSize = msg.mapSize;
    orbs = msg.orbs || [];
    if (msg.players) msg.players.forEach(p => players.set(p.id, { ...p, trail: [] }));
    if (msg.config) applyConfig(msg.config);
    if (msg.id) myId = msg.id;
  }

  else if (msg.type === "spawn") {
    players.set(msg.player.id, { ...msg.player, trail: [] });
  }

  else if (msg.type === "despawn") {
    players.delete(msg.id);
  }

  else if (msg.type === "death") {
    const p = players.get(msg.id);
    if (p) { p.alive = false; p.trail.length = 0; if (p.id === myId) playBeep(200, 0.12, "sawtooth"); }
  }

  else if (msg.type === "orbs") {
    orbs = msg.orbs || [];
    const p = players.get(msg.id);
    if (p) { p.score = msg.score; if (p.id === myId) playBeep(880, 0.06, "square"); }
  }

  else if (msg.type === "reset") {
    players.clear();
    msg.players.forEach(p => players.set(p.id, { ...p, trail: [] }));
    orbs = msg.orbs || [];
  }

  else if (msg.type === "state") {
    if (msg.config) applyConfig(msg.config);
    msg.players.forEach(s => {
      let p = players.get(s.id);
      if (!p) {
        p = { id: s.id, name: s.name, avatar: s.avatar, trail: [] };
        players.set(s.id, p);
      }
      p.x = s.x; p.y = s.y; p.score = s.score; p.alive = s.alive;
      p.avatar = s.avatar; p.name = s.name;
      p.hitbox = s.hitbox; p.boosting = !!s.boosting;

      if (s.alive) {
        p.trail.push({ x: s.x, y: s.y, t: performance.now(), score: s.score });
        const keep = Math.max(lBase, lBase + s.score * lGrow);
        if (p.trail.length > keep) p.trail.splice(0, p.trail.length - keep);
      }
    });
  }
}

function applyConfig(cfg) {
  if (typeof cfg.wBase === "number") wBase = cfg.wBase;
  if (typeof cfg.wGrow === "number") wGrow = cfg.wGrow;
  if (typeof cfg.lBase === "number") lBase = cfg.lBase;
  if (typeof cfg.lGrow === "number") lGrow = cfg.lGrow;
  if (typeof cfg.segmentPerPoint === "number") segmentPerPoint = cfg.segmentPerPoint;
  if (typeof cfg.segmentOverlap === "number") segmentOverlap = cfg.segmentOverlap;
  if (typeof cfg.emojiPx === "number") emojiPx = cfg.emojiPx;
  if (typeof cfg.renderScale === "number") renderScale = cfg.renderScale;
}

// ====== INPUT ======
const keys = {};
window.addEventListener("keydown", e => keys[e.code] = true);
window.addEventListener("keyup", e => keys[e.code] = false);
window.addEventListener("mousemove", e => {
  if (!myId || !players.has(myId)) return;
  const me = players.get(myId);
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const cam = camera();
  const wx = mx + cam.x, wy = my + cam.y;
  const ang = Math.atan2(wy - me.y, wx - me.x);
  send({ type: "input", dir: ang });
});

let last = performance.now();
function loop(ts) {
  const dt = (ts - last) / 1000; last = ts;
  if (myId && players.has(myId)) {
    const dx = (keys["KeyD"] ? 1 : 0) - (keys["KeyA"] ? 1 : 0);
    const dy = (keys["KeyS"] ? 1 : 0) - (keys["KeyW"] ? 1 : 0);
    if (dx || dy) send({ type: "input", dir: Math.atan2(dy, dx) });
    send({ type: "input", boost: !!keys["ShiftLeft"] || !!keys["ShiftRight"] });
  }
  pulse += dt * 6;
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ====== CAMERA ======
function camera() {
  const w = canvas.width, h = canvas.height;
  if (!myId || !players.has(myId)) return { x: mapSize / 2 - w / 2, y: mapSize / 2 - h / 2 };
  const me = players.get(myId);
  let x = me.x - w / 2, y = me.y - h / 2;
  x = Math.max(0, Math.min(mapSize - w, x));
  y = Math.max(0, Math.min(mapSize - h, y));
  return { x, y };
}

// ====== DRAW ======
function draw() {
  const w = canvas.width, h = canvas.height;
  const cam = camera();
  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.globalAlpha = 0.12;
  for (let x = 0; x < mapSize; x += 100) ctx.fillRect(x - cam.x, -cam.y, 1, mapSize);
  for (let y = 0; y < mapSize; y += 100) ctx.fillRect(-cam.x, y - cam.y, mapSize, 1);
  ctx.globalAlpha = 1;

  // Border
  ctx.strokeStyle = "#202640";
  ctx.strokeRect(-cam.x, -cam.y, mapSize, mapSize);

  // Orbs
  orbs.forEach(o => {
    ctx.fillStyle = "rgba(122,162,247,0.22)";
    ctx.beginPath(); ctx.arc(o.x - cam.x, o.y - cam.y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = o.bonus ? "#FFD700" : "#7aa2f7";
    ctx.beginPath(); ctx.arc(o.x - cam.x, o.y - cam.y, 6, 0, Math.PI * 2); ctx.fill();
  });

  // Trails as emojis
  for (const p of players.values()) {
    if (!p.alive || !p.trail || p.trail.length < 2) continue;
    const count = Math.floor(p.score / segmentPerPoint);
    if (count <= 0) continue;

    const spacing = emojiPx * (1 - segmentOverlap);
    const pts = [];
    let need = spacing;
    for (let i = p.trail.length - 1; i > 0 && pts.length < count; i--) {
      const a = p.trail[i], b = p.trail[i - 1];
      const dx = a.x - b.x, dy = a.y - b.y;
      const segLen = Math.hypot(dx, dy);
      if (segLen <= 0) continue;
      while (need <= segLen && pts.length < count) {
        const t = 1 - (need / segLen);
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const dir = Math.atan2(a.y - b.y, a.x - b.x);
        pts.push({ x, y, dir });
        need += spacing;
      }
      need -= segLen;
    }

    const segSize = Math.max(22||(p.hitbox || emojiPx) * renderScale);
    ctx.font = `${segSize}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
    for (let i = pts.length - 1; i >= 0; i--) {
      const s = pts[i];
      const sx = s.x - cam.x, sy = s.y - cam.y;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(s.dir);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(p.avatar, 0, 0);
      ctx.restore();
    }
  }

  // Heads
  for (const p of players.values()) {
    if (!p.alive) continue;
    let dir = 0;
    if (p.trail?.length >= 2) {
      const a = p.trail[p.trail.length - 1], b = p.trail[p.trail.length - 2];
      dir = Math.atan2(a.y - b.y, a.x - b.x);
    }

    const x = p.x - cam.x, y = p.y - cam.y;
    const headSize = Math.max(22||(p.hitbox || emojiPx) * renderScale);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir);
    if (p.boosting) { ctx.shadowColor = "rgba(255,50,50,0.9)"; ctx.shadowBlur = 20; }
    ctx.font = `${headSize}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(p.avatar, 0, 0);
    ctx.restore();

    // Name
    ctx.font = "12px system-ui";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(`${p.name} (${Math.floor(p.score)})`, x, y - headSize * 0.6);
  }

  renderScoreboard();
}

// ====== SCOREBOARD ======
function renderScoreboard() {
  if (!sb) return;
  const list = Array.from(players.values()).filter(p => p.alive).sort((a, b) => b.score - a.score).slice(0, 10);
  if (!list.length) {
    sb.innerHTML = `<div class="score-title">Punkte</div><div class="score-empty">Noch keine Spieler aktiv</div>`;
    return;
  }
  const rows = list.map((p, idx) =>
    `<div class="scoreitem"><span class="name">${idx + 1}. ${esc(p.name)}</span><span class="points">${Math.floor(p.score)}</span></div>`
  ).join("");
  sb.innerHTML = `<div class="score-title">Punkte</div>${rows}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c])); }
