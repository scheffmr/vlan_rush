
# LAN Rush — VLAN Edition (Realtime, self-hosted, no external deps)

A lightweight browser multiplayer game to motivate VLAN/Trunk configuration in a classroom lab.
Players join **in realtime** as soon as their network/VLAN config is correct.
No third-party libraries are required for the server. Uses a tiny built-in WebSocket implementation.

## Features
- Realtime movement and scoring
- Join anytime; disconnects visible immediately
- Avatars: Cat 🐱, Robot 🤖, Packet 📦 (players choose)
- Modes: Collect, Capture the Flag, King of the Switch (select at server start)
- Spectator/Scoreboard view for projector
- Admin panel to switch rounds, set score/time limits
- Up to ~20 concurrent players (tested target)

## Requirements
- **Node.js 18+** on the teacher PC (no npm install needed)
- Clients: Any modern browser (Chromium/Firefox/Edge)
- Network: Plain HTTP + WebSocket inside your VLAN

## Quick Start
1. Extract this ZIP on the teacher PC.
2. Start the server:
   - Windows: double-click `start_server.bat`
   - Linux/macOS: `bash start_server.sh`
3. By default the server listens on **0.0.0.0:3000**.
4. Students open `http://<teacher-ip>:3000/` in their browser.
5. Projector view: `http://<teacher-ip>:3000/spectator.html`
6. Admin panel: `http://<teacher-ip>:3000/admin.html`

### Choose Mode
At startup, the server reads `MODE` from environment variables. Options:
- `collect` (default)
- `ctf`
- `king`

Example:
```bash
# Windows (PowerShell)
$env:MODE="king"; node server.js
# Linux/macOS
MODE=ctf node server.js
```

### Optional config
Edit `config.json`:
- `port`: HTTP/WS port (default 3000)
- `maxPlayers`: default 20
- `round` object: scoreLimit, timeLimitSec, mapSize

## Classroom VLAN/Trunk idea
- Teacher switch: VLAN 98 (or your choice)
- Student switches must create VLAN 98 and trunk the uplink
- As soon as L2 is correct, they can reach the server and **appear in-game**

## Notes
- This is an educational sample; security is intentionally simple for offline lab use.
- If you later add routing/ACL tasks, block the server IP until rules are correct.
