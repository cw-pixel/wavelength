const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

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

const rooms = {};

function randomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom({ targetRounds, clueTimeSecs }) {
  let code;
  do { code = randomCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    phase: 'lobby',
    targetRounds: targetRounds || 5,
    clueTimeSecs: clueTimeSecs || 60,
    roundsPlayed: 0,
    teams: [],
    activeTeamIdx: 0,
    turn: null,
    hostId: null,
    timers: {}   // holds server-side setTimeout ids
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code]; }

function clearRoomTimers(room) {
  Object.values(room.timers || {}).forEach(t => clearTimeout(t));
  room.timers = {};
}

function sendAllState(room) {
  const code = room.code;
  // Strip targetAngle for non-reveal phases
  const strippedTurn = room.turn ? { ...room.turn } : null;
  if (strippedTurn && room.phase !== 'reveal') delete strippedTurn.targetAngle;
  const strippedRoom = { ...room, turn: strippedTurn, timers: undefined };
  io.to(code).emit('room_update', strippedRoom);
  // Send full state (with targetAngle) to psychic only
  if (room.turn && room.turn.psychicId) {
    const ps = io.sockets.sockets.get(room.turn.psychicId);
    if (ps) ps.emit('room_update', { ...room, timers: undefined, _isPsychic: true });
  }
}

function calcPoints(targetAngle, dialAngle) {
  const dist = Math.abs(targetAngle - dialAngle);
  if (dist <= 3)  return 5;  // dead center — bonus, no counter
  if (dist <= 8)  return 4;
  if (dist <= 14) return 3;
  if (dist <= 20) return 2;
  return 0;
}

const REVEAL_SECS = 60;

function startRevealTimeout(room) {
  room.turn.revealDeadlineTs = Date.now() + REVEAL_SECS * 1000;
  room.turn.revealTimeSecs = REVEAL_SECS;
  room.timers.revealTimeout = setTimeout(() => {
    const r = getRoom(room.code);
    if (!r || r.phase !== 'reveal') return;
    advanceTurn(r);
  }, REVEAL_SECS * 1000);
}

function doReveal(room, skipCounter) {
  clearRoomTimers(room);
  const pts = calcPoints(room.turn.targetAngle, room.turn.dialAngle);
  room.teams[room.activeTeamIdx].score += pts;
  room.turn.pointsScored = pts;
  room.turn.deadCenter = pts === 5;

  if (skipCounter || pts === 5) {
    // Dead center OR skip — no counter phase
    room.turn.counterGuess = null;
    room.phase = 'reveal';
    checkGameOver(room);
    if (room.phase === 'reveal') startRevealTimeout(room);
    io.to(room.code).emit('room_update', { ...room, timers: undefined });
  }
}

function doCounterReveal(room, direction) {
  clearRoomTimers(room);
  const pts = room.turn.pointsScored;
  const activeIdx = room.activeTeamIdx;

  if (direction) {
    const targetIsRight = room.turn.targetAngle > room.turn.dialAngle;
    const correct = (direction === 'right' && targetIsRight) || (direction === 'left' && !targetIsRight);
    room.turn.counterCorrect = correct;
    const counterTeamIdx = room.teams.findIndex((t, i) => i !== activeIdx && t.players.some(p => p.id === room.turn.counterSocketId));
    room.turn.counterTeamIdx = counterTeamIdx;
    if (correct && counterTeamIdx >= 0) room.teams[counterTeamIdx].score += 1;
  }
  room.turn.counterGuess = direction;
  room.phase = 'reveal';
  checkGameOver(room);
  if (room.phase === 'reveal') startRevealTimeout(room);
  io.to(room.code).emit('room_update', { ...room, timers: undefined });
}

function checkGameOver(room) {
  // Game over after targetRounds total rounds (each team's turn = 1 round each)
  // A "full round" = all teams have played once. We track total turns played.
  if (room.roundsPlayed >= room.targetRounds * room.teams.length) {
    const maxScore = Math.max(...room.teams.map(t => t.score));
    const winners = room.teams.filter(t => t.score === maxScore);
    room.phase = 'gameover';
    room.winner = winners.map(t => t.name).join(' & ');
  }
}

function beginTurn(room) {
  clearRoomTimers(room);
  const team = room.teams[room.activeTeamIdx];
  const psychic = team.players[team.psychicIdx];
  const card = CARDS[Math.floor(Math.random() * CARDS.length)];
  const targetAngle = Math.floor(Math.random() * 160) + 10;

  const teamPsychics = {};
  room.teams.forEach(t => {
    const p = t.players[t.psychicIdx];
    if (p) teamPsychics[t.name] = p.name;
  });

  room.turn = {
    card, targetAngle, dialAngle: 90,
    clue: null, counterGuess: null,
    psychicId: psychic ? psychic.id : null,
    psychicName: psychic ? psychic.name : 'Unknown',
    teamName: team.name,
    teamIdx: room.activeTeamIdx,
    teamPsychics,
    pointsScored: null,
    clueDeadlineTs: Date.now() + room.clueTimeSecs * 1000,
    clueTimeSecs: room.clueTimeSecs
  };
  room.phase = 'clue';
  sendAllState(room);

  // Auto-advance if psychic doesn't give a clue in time
  room.timers.clueTimeout = setTimeout(() => {
    const r = getRoom(room.code);
    if (!r || r.phase !== 'clue') return;
    // Auto-advance to next turn (skip this turn)
    advanceTurn(r);
  }, room.clueTimeSecs * 1000);
}

function advanceTurn(room) {
  clearRoomTimers(room);
  if (room.phase === 'gameover') return;
  room.phase = 'transitioning';
  const team = room.teams[room.activeTeamIdx];
  team.psychicIdx = (team.psychicIdx + 1) % team.players.length;
  room.roundsPlayed++;
  room.activeTeamIdx = (room.activeTeamIdx + 1) % room.teams.length;
  checkGameOver(room);
  if (room.phase !== 'gameover') beginTurn(room);
  else io.to(room.code).emit('room_update', { ...room, timers: undefined });
}

// ─── SOCKET HANDLERS ──────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create_room', ({ targetRounds, clueTimeSecs }, cb) => {
    const room = createRoom({ targetRounds, clueTimeSecs });
    room.hostId = socket.id;
    socket.join(room.code);
    cb({ code: room.code });
  });

  socket.on('join_room', ({ code, playerName, teamName }, cb) => {
    const room = getRoom(code.toUpperCase());
    if (!room) return cb({ error: 'Room not found' });
    if (room.phase !== 'lobby') return cb({ error: 'Game already in progress' });

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

  // Fetch current teams in a room (for join screen team picker)
  socket.on('get_room_teams', ({ code }, cb) => {
    const room = getRoom(code.toUpperCase());
    if (!room) return cb({ error: 'Room not found' });
    if (room.phase !== 'lobby') return cb({ error: 'Game already started' });
    cb({ teams: room.teams.map(t => ({ name: t.name, count: t.players.length })) });
  });

  socket.on('start_game', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    const invalid = room.teams.find(t => t.players.length !== 2);
    if (invalid || room.teams.length < 2) {
      socket.emit('error_msg', 'Each team needs exactly 2 players and there must be at least 2 teams.');
      return;
    }
    room.activeTeamIdx = 0;
    room.roundsPlayed = 0;
    beginTurn(room);
  });

  socket.on('submit_clue', ({ code, clue }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'clue') return;
    if (room.turn.psychicId !== socket.id) return;
    if (!clue || !clue.trim()) return;
    clearRoomTimers(room);
    room.turn.clue = clue.trim();
    room.phase = 'guess';
    sendAllState(room);
  });

  socket.on('move_dial', ({ code, angle }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'guess') return;
    const team = room.teams[room.activeTeamIdx];
    if (!team.players.some(p => p.id === socket.id)) return;
    if (socket.id === room.turn.psychicId) return;
    room.turn.dialAngle = Math.max(0, Math.min(180, angle));
    sendAllState(room);
  });

  socket.on('lock_guess', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'guess') return;
    const team = room.teams[room.activeTeamIdx];
    if (!team.players.some(p => p.id === socket.id)) return;
    if (socket.id === room.turn.psychicId) return;

    const pts = calcPoints(room.turn.targetAngle, room.turn.dialAngle);
    if (pts === 5) {
      // Dead center — doReveal handles scoring, reveal timeout, and broadcast
      doReveal(room, true);
    } else {
      room.turn.pointsScored = pts;
      room.teams[room.activeTeamIdx].score += pts;
      room.phase = 'counter';
      sendAllState(room);
    }
  });

  socket.on('counter_guess', ({ code, direction }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'counter') return;
    const activeIdx = room.activeTeamIdx;
    const opponentTeam = room.teams.find((t, i) => i !== activeIdx && t.players.some(p => p.id === socket.id));
    if (!opponentTeam) return;
    const opponentPsychic = opponentTeam.players[opponentTeam.psychicIdx];
    if (opponentPsychic && opponentPsychic.id === socket.id) return;

    room.turn.counterSocketId = socket.id;
    doCounterReveal(room, direction);
  });

  socket.on('skip_counter', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'counter') return;
    const activeIdx = room.activeTeamIdx;
    const opponentTeam = room.teams.find((t, i) => i !== activeIdx && t.players.some(p => p.id === socket.id));
    if (!opponentTeam) return;
    const opponentPsychic = opponentTeam.players[opponentTeam.psychicIdx];
    if (opponentPsychic && opponentPsychic.id === socket.id) return;

    doCounterReveal(room, null);
  });

  socket.on('next_turn', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'reveal') return;
    if (!room.turn || room.turn.psychicId !== socket.id) return;
    advanceTurn(room);
  });

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
server.listen(PORT, () => console.log(`Wavelength server on http://localhost:${PORT}`));
