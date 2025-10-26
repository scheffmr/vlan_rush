
# VLAN-Rush V2 — IO Edition (continuous, light trails)

**Continuous** multiplayer browser game for VLAN/Trunk labs.
- Join anytime; no rounds
- IO-style rules: if you crash into **any trail or wall**, you **die** and respawn small (score reset)
- Collect orbs to grow a **light trail** (looks great on projector)
- Avatars: Cat 🐱, Robot 🤖, Packet 📦 (head icon)
- Spectator and Admin (reset map, set map size/orb count)

## Start
- Windows: `start_server.bat`
- Linux/macOS: `./start_server.sh`
- Default: `http://<teacher-ip>:3000`
- Spectator: `/spectator.html`
- Admin: `/admin.html`

## Config (config.json)
- port, maxPlayers, mapSize, orbCount, tickRate, respawnDelayMs

> Node 18+ recommended. No external deps.
