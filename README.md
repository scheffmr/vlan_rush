
# VLAN-Rush V4.3 — IO Edition

**What's new**
- Emoji Avatars (real emoji rendering) — random on join
- Name = client IP (auto), PC-Name optional later
- Self-collision only if trail is in **forward cone** (default 120°)
- Respawn invulnerability ~0.3s
- Boost temporarily shrinks visual trail length (recovers when boost stops)
- Pickup/Death sounds (WebAudio; no files needed)
- Scoreboard page `/score.html` for projector
- No spectator, no pre-join UI

**Start**
- Windows: `start_server.bat`
- Linux/macOS: `./start_server.sh`
Open:
- HTTP → `http://<IP>:3000/`
- HTTPS → `https://<IP>:3443/` (accept cert warning)
Admin reset: `/admin.html`
Scoreboard: `/score.html`
