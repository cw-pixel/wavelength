const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── SPECTRUM CARDS ──────────────────────────────────────────────────
const CARDS = [
  ["Cold","Hot"],["Rough","Smooth"],["Dark","Light"],["Sad","Happy"],
  ["Slow","Fast"],["Ugly","Beautiful"],["Quiet","Loud"],["Simple","Complex"],
  ["Weak","Strong"],["Bad","Good"],["Boring","Exciting"],["Cheap","Expensive"],
  ["Old","New"],["Small","Large"],["Rare","Common"],["Natural","Artificial"],
  ["Dry","Wet"],["Soft","Hard"],["Safe","Dangerous"],["Calm","Chaotic"],
  ["Fictional","Real"],["Useless","Useful"],["Serious","Funny"],["Familiar","Exotic"],
  ["Healthy","Unhealthy"],["Polite","Rude"],["Short","Tall"],["Gentle","Aggressive"],
  ["Easy","Difficult"],["Boring","Fascinating"],["Loud","Silent"],["Cheap","Luxurious"],
  ["Amateur","Professional"],["Abstract","Concrete"],["Ancient","Modern"],["Local","Global"]
];

// ─── ROOMS ───────────────────────────────────────────────────────────
// room: {
//   code, phase, targetScore,
//   teams: [ { name, players: [{id, name, connected}], score, psychicIdx } ],
//   activeTeamIdx,
//   turn: { card, targetAngle, dialAngle, clue, counterGuess, psychicId }
// }
const rooms = {};

function randomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom(targetScore) {
  let code;
  do { code = randomCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    phase: 'lobby',       // lobby | clue | guess | counter | reveal
    targetScore: targetScore || 10,
    teams: [],
    activeTeamIdx: 0,
    turn: null,
    hostId: null
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code]; }

function broadcastRoom(code) {
  const room = getRoom(code);
  if (!room) return;
  // Build a sanitized state — hide targetAngle except for psychic
  io.to(code).emit('room_update', roomForAll(room));
}

function roomForAll(room) {
  // strip targetAngle from turn for non-psychic reveal
  const turn = room.turn ? { ...room.turn } : null;
  if (turn && room.phase !== 'reveal') {
    delete turn.targetAngle;
  }
  return { ...room, turn };
}

function roomForPsychic(room) {
  return { ...room }; // full state including targetAngle
}

function sendPsychicState(room) {
  if (!room.turn) return;
  const psychicId = room.turn.psychicId;
  const psychicSocket = io.sockets.sockets.get(psychicId);
  if (psychicSocket) {
    psychicSocket.emit('room_update', { ...room, _isPsychic: true });
  }
}

function sendAllState(room) {
  // Send stripped state to everyone, then full state to psychic
  const code = room.code;
  const strippedTurn = room.turn ? { ...room.turn } : null;
  if (strippedTurn && room.phase !== 'reveal') {
    delete strippedTurn.targetAngle;
  }
  const strippedRoom = { ...room, turn: strippedTurn };

  io.to(code).emit('room_update', strippedRoom);

  // Override for psychic
  if (room.turn && room.turn.psychicId) {
    const psychicSocket = io.sockets.sockets.get(room.turn.psychicId);
    if (psychicSocket) {
      psychicSocket.emit('room_update', { ...room, _isPsychic: true });
    }
  }
}

function beginTurn(room) {
  const team = room.teams[room.activeTeamIdx];
  const psychicIdx = team.psychicIdx;
  const psychic = team.players[psychicIdx];
  const card = CARDS[Math.floor(Math.random() * CARDS.length)];
  const targetAngle = Math.floor(Math.random() * 160) + 10;

  room.turn = {
    card,
    targetAngle,
    dialAngle: 90,
    clue: null,
    counterGuess: null,
    psychicId: psychic ? psychic.id : null,
    psychicName: psychic ? psychic.name : 'Unknown',
    teamName: team.name,
    teamIdx: room.activeTeamIdx
  };
  room.phase = 'clue';
  sendAllState(room);
}

function calcPoints(targetAngle, dialAngle) {
  const dist = Math.abs(targetAngle - dialAngle);
  if (dist <= 8) return 4;
  if (dist <= 16) return 3;
  if (dist <= 24) return 2;
  return 0;
}

// ─── SOCKET HANDLERS ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Create room ──
  socket.on('create_room', ({ targetScore }, cb) => {
    const room = createRoom(targetScore);
    room.hostId = socket.id;
    socket.join(room.code);
    cb({ code: room.code });
  });

  // ── Join room ──
  socket.on('join_room', ({ code, playerName, teamName }, cb) => {
    const room = getRoom(code.toUpperCase());
    if (!room) return cb({ error: 'Room not found' });
    if (room.phase !== 'lobby') return cb({ error: 'Game already in progress' });

    // Find or create team
    let team = room.teams.find(t => t.name === teamName);
    if (!team) {
      if (room.teams.length >= 6) return cb({ error: 'Too many teams' });
      team = { name: teamName, players: [], score: 0, psychicIdx: 0 };
      room.teams.push(team);
    }
    if (team.players.length >= 2) return cb({ error: 'Team is full (max 2 players)' });

    team.players.push({ id: socket.id, name: playerName, connected: true });
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.data.playerName = playerName;
    socket.data.teamName = teamName;

    cb({ ok: true });
    sendAllState(room);
  });

  // ── Start game (host) ──
  socket.on('start_game', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    // Validate: all teams have exactly 2 players
    const invalid = room.teams.find(t => t.players.length !== 2);
    if (invalid || room.teams.length < 2) {
      socket.emit('error_msg', 'Each team needs exactly 2 players and there must be at least 2 teams.');
      return;
    }
    room.activeTeamIdx = 0;
    beginTurn(room);
  });

  // ── Submit clue (psychic only) ──
  socket.on('submit_clue', ({ code, clue }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'clue') return;
    if (room.turn.psychicId !== socket.id) return;
    if (!clue || !clue.trim()) return;
    room.turn.clue = clue.trim();
    room.phase = 'guess';
    sendAllState(room);
  });

  // ── Move dial (guessing team members) ──
  socket.on('move_dial', ({ code, angle }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'guess') return;
    // Only non-psychic members of active team can move dial
    const team = room.teams[room.activeTeamIdx];
    const isMember = team.players.some(p => p.id === socket.id);
    if (!isMember || socket.id === room.turn.psychicId) return;
    room.turn.dialAngle = Math.max(2, Math.min(178, angle));
    sendAllState(room);
  });

  // ── Lock in guess ──
  socket.on('lock_guess', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'guess') return;
    const team = room.teams[room.activeTeamIdx];
    const isMember = team.players.some(p => p.id === socket.id);
    if (!isMember || socket.id === room.turn.psychicId) return;
    room.phase = 'counter';
    sendAllState(room);
  });

  // ── Counter guess ──
  socket.on('counter_guess', ({ code, direction }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'counter') return;
    // Must be from opposing team
    const activeIdx = room.activeTeamIdx;
    const isOpponent = room.teams.some((t, i) => i !== activeIdx && t.players.some(p => p.id === socket.id));
    if (!isOpponent) return;
    room.turn.counterGuess = direction; // 'left' | 'right' | null
    room.phase = 'reveal';

    // Score
    const pts = calcPoints(room.turn.targetAngle, room.turn.dialAngle);
    room.teams[room.activeTeamIdx].score += pts;

    if (direction) {
      const targetIsRight = room.turn.targetAngle > room.turn.dialAngle;
      const correct = (direction === 'right' && targetIsRight) || (direction === 'left' && !targetIsRight);
      room.turn.counterCorrect = correct;
      room.turn.counterTeamIdx = room.teams.findIndex((t, i) => i !== activeIdx && t.players.some(p => p.id === socket.id));
      if (correct && room.turn.counterTeamIdx >= 0) {
        room.teams[room.turn.counterTeamIdx].score += 1;
      }
    }
    room.turn.pointsScored = pts;

    // Check win
    const winner = room.teams.find(t => t.score >= room.targetScore);
    if (winner) {
      room.phase = 'gameover';
      room.winner = winner.name;
    }

    io.to(code).emit('room_update', room); // full state — target revealed
  });

  // ── Skip counter ──
  socket.on('skip_counter', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'counter') return;
    room.turn.counterGuess = null;
    room.phase = 'reveal';
    const pts = calcPoints(room.turn.targetAngle, room.turn.dialAngle);
    room.teams[room.activeTeamIdx].score += pts;
    room.turn.pointsScored = pts;

    const winner = room.teams.find(t => t.score >= room.targetScore);
    if (winner) { room.phase = 'gameover'; room.winner = winner.name; }

    io.to(code).emit('room_update', room);
  });

  // ── Next turn ──
  socket.on('next_turn', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'reveal') return;
    // Advance psychic for active team
    const team = room.teams[room.activeTeamIdx];
    team.psychicIdx = (team.psychicIdx + 1) % team.players.length;
    // Advance active team
    room.activeTeamIdx = (room.activeTeamIdx + 1) % room.teams.length;
    beginTurn(room);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;
    room.teams.forEach(t => {
      const p = t.players.find(p => p.id === socket.id);
      if (p) p.connected = false;
    });
    sendAllState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wavelength server running on http://localhost:${PORT}`));
