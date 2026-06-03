# Wavelength — Multiplayer Web Game

A real-time, online multiplayer version of the Wavelength party game. Players on separate devices join the same room and play together live.

## Rules Summary
- Teams of **exactly 2 players** each; at least 2 teams required.
- Each turn, one player is the **Psychic** — they see the secret target zone on the spectrum wheel and give a single word/phrase clue.
- Their teammate drags the dial to guess where on the spectrum the target is.
- The **opposing team** gets a bonus point if they correctly guess whether the target is left or right of the dial.
- First team to reach the target score wins.
- The Psychic role **alternates** between the two teammates each time that team plays.

---

## Quick Start (Local)

```bash
npm install
npm start
# Open http://localhost:3000
```

---

## Deployment Options

### Option 1 — Railway (Recommended, free tier available)
1. Push this folder to a GitHub repo.
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub.
3. Select your repo. Railway auto-detects Node.js and runs `npm start`.
4. Your game is live at the provided URL (e.g. `https://wavelength-xyz.up.railway.app`).

### Option 2 — Render
1. Push to GitHub.
2. Go to [render.com](https://render.com) → New Web Service → connect repo.
3. Build command: `npm install`  
   Start command: `node server.js`
4. Free tier works fine for small groups.

### Option 3 — Fly.io
```bash
npm install -g flyctl
fly launch
fly deploy
```

### Option 4 — VPS / Any Linux Server
```bash
# Install Node 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Clone or copy the project, then:
npm install
npm start

# For production, use PM2:
npm install -g pm2
pm2 start server.js --name wavelength
pm2 save && pm2 startup

# Optionally put Nginx in front on port 80/443
```

---

## How Multiplayer Works
- Server uses **Socket.io** for real-time bidirectional communication.
- The target angle is **never sent to non-Psychic players** — the server filters it per-socket.
- When the Psychic moves to the clue phase, only their socket receives the full state with `targetAngle`.
- All dial movements are **broadcast live** so everyone watches the dial move in real-time.
- Room codes are **4-character alphanumeric** strings. Share the invite link — it pre-fills the join code automatically.

## Project Structure
```
wavelength/
├── server.js          # Express + Socket.io game server
├── package.json
└── public/
    └── index.html     # Complete single-file frontend
```
