const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, 'outputs');
const rooms = new Map();
const MAX_PLAYERS = 80;
const QUESTION_SECONDS = 20;

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function publicState(room, playerId, isHost) {
  const player = room.players.get(playerId);
  let question = null;
  if (room.status === 'playing' && room.questions[room.questionIndex]) {
    const q = room.questions[room.questionIndex];
    question = { number: room.questionIndex + 1, total: room.questions.length, text: q.q, answers: q.a, deadline: room.deadline };
    if (isHost || room.revealed) question.correct = q.correct;
    if (room.revealed) question.explanation = q.why || `The correct answer is ${q.a[q.correct]}.`;
    if (player) {
      const answer = room.answers.get(playerId);
      if (answer) question.myAnswer = { choice: answer.choice, correct: answer.choice === q.correct, points: answer.points };
    }
  }
  const leaderboard = [...room.players.values()].map(p => ({ id: p.id, nickname: p.nickname, score: p.score })).sort((a, b) => b.score - a.score);
  return { pin: room.pin, title: room.title, status: room.status, capacity: MAX_PLAYERS, players: [...room.players.values()].map(p => ({ id: p.id, nickname: p.nickname, score: p.score, answered: room.answers.has(p.id) })), question, leaderboard, answered: room.answers.size, revealed: room.revealed, isHost };
}
function broadcast(room) {
  for (const client of room.clients) {
    if (client.res.writableEnded) continue;
    client.res.write(`data: ${JSON.stringify(publicState(room, client.playerId, client.isHost))}\n\n`);
  }
}
function reveal(room) {
  if (room.status !== 'playing' || room.revealed) return;
  room.revealed = true;
  clearTimeout(room.timer);
  broadcast(room);
}
function startQuestion(room) {
  room.revealed = false;
  room.answers.clear();
  room.deadline = Date.now() + QUESTION_SECONDS * 1000;
  room.timer = setTimeout(() => reveal(room), QUESTION_SECONDS * 1000);
  broadcast(room);
}
function getRoom(pin) { return rooms.get(pin); }
function authHost(room, req, body) { return room && (req.headers['x-host-token'] === room.hostToken || body.hostToken === room.hostToken); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-host-token' }); return res.end(); }
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, maxPlayers: MAX_PLAYERS });
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readBody(req); const quiz = body.quiz;
      if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length < 1 || quiz.questions.length > 100) return send(res, 400, { error: 'A quiz must have between 1 and 100 questions.' });
      for (const q of quiz.questions) if (!q.q || !Array.isArray(q.a) || q.a.length < 2 || q.a.length > 4 || !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.a.length) return send(res, 400, { error: 'Each question needs 2–4 answers and one correct answer.' });
      let pin; do { pin = String(100000 + crypto.randomInt(900000)); } while (rooms.has(pin));
      const room = { pin, title: String(quiz.title || 'Classroom quiz').slice(0, 80), questions: quiz.questions, hostToken: crypto.randomBytes(24).toString('hex'), status: 'lobby', questionIndex: -1, players: new Map(), answers: new Map(), clients: new Set(), revealed: false, deadline: null, timer: null };
      rooms.set(pin, room);
      return send(res, 201, { pin, hostToken: room.hostToken, capacity: MAX_PLAYERS });
    }
    const events = url.pathname.match(/^\/api\/rooms\/(\d{6})\/events$/);
    if (req.method === 'GET' && events) {
      const room = getRoom(events[1]); if (!room) return send(res, 404, { error: 'Room not found.' });
      const host = url.searchParams.get('host') === room.hostToken;
      const playerId = url.searchParams.get('player') || '';
      if (!host && !room.players.has(playerId)) return send(res, 403, { error: 'Join this room first.' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write('retry: 2000\n\n');
      const client = { res, playerId, isHost: host }; room.clients.add(client); res.write(`data: ${JSON.stringify(publicState(room, playerId, host))}\n\n`);
      res.on('close', () => room.clients.delete(client)); return;
    }
    const route = url.pathname.match(/^\/api\/rooms\/(\d{6})\/(join|start|reveal|next|answer|end)$/);
    if (req.method === 'POST' && route) {
      const room = getRoom(route[1]); if (!room) return send(res, 404, { error: 'Room not found. Ask your teacher for a new PIN.' });
      const action = route[2], body = await readBody(req);
      if (action === 'join') {
        if (room.status !== 'lobby') return send(res, 409, { error: 'This quiz has already started.' });
        if (room.players.size >= MAX_PLAYERS) return send(res, 409, { error: 'This room is full (80 students maximum).' });
        const nickname = String(body.nickname || '').trim().slice(0, 20); if (!nickname) return send(res, 400, { error: 'Enter a nickname.' });
        const id = crypto.randomBytes(12).toString('hex'); room.players.set(id, { id, nickname, score: 0 }); broadcast(room); return send(res, 201, { playerId: id });
      }
      if (action !== 'answer' && !authHost(room, req, body)) return send(res, 403, { error: 'Only the quiz host can do that.' });
      if (action === 'start') { if (room.status !== 'lobby') return send(res, 409, { error: 'Quiz is already running.' }); room.status = 'playing'; room.questionIndex = 0; startQuestion(room); return send(res, 200, { ok: true }); }
      if (action === 'reveal') { reveal(room); return send(res, 200, { ok: true }); }
      if (action === 'next') { if (room.status !== 'playing' || !room.revealed) return send(res, 409, { error: 'Reveal the answer before continuing.' }); room.questionIndex++; if (room.questionIndex >= room.questions.length) { room.status = 'finished'; broadcast(room); } else startQuestion(room); return send(res, 200, { ok: true }); }
      if (action === 'end') { room.status = 'finished'; clearTimeout(room.timer); broadcast(room); return send(res, 200, { ok: true }); }
      if (action === 'answer') {
        if (room.status !== 'playing' || room.revealed) return send(res, 409, { error: 'This question is closed.' });
        const player = room.players.get(body.playerId); if (!player) return send(res, 403, { error: 'Join the room again.' });
        if (room.answers.has(player.id)) return send(res, 409, { error: 'Answer already submitted.' });
        const q = room.questions[room.questionIndex], choice = Number(body.choice); if (!Number.isInteger(choice) || choice < 0 || choice >= q.a.length) return send(res, 400, { error: 'Choose an answer.' });
        const isCorrect = choice === q.correct; const points = isCorrect ? Math.max(500, Math.round(1000 + 1000 * Math.max(0, room.deadline - Date.now()) / (QUESTION_SECONDS * 1000))) : 0;
        room.answers.set(player.id, { choice, points }); player.score += points; broadcast(room); if (room.answers.size === room.players.size && room.players.size) reveal(room); return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res); }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) { if (!res.headersSent) send(res, 500, { error: error.message || 'Server error.' }); else res.end(); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Quizzy server listening on port ${PORT}`));
