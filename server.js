/**
 * مجهول — Anonymous Chat Server
 * Node.js + Socket.io
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Railway يعطي PORT جاهز
const PORT = Number(process.env.PORT) || 8080;

const CONFIG = {
  MAX_MSG_LEN: 500,
  MAX_MSGS_MIN: 60,
  ALLOWED_ORIGIN: process.env.CLIENT_URL || '*',
  PING_TIMEOUT: 20000,
  PING_INTERVAL: 25000,
};

// SECURITY
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(
  cors({
    origin: CONFIG.ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  })
);

app.use(
  rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    message: { error: 'طلبات كثيرة جداً، انتظر قليلاً' },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(express.json({ limit: '10kb' }));

// SOCKET.IO
const io = new Server(server, {
  cors: {
    origin: CONFIG.ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  },
  pingTimeout: CONFIG.PING_TIMEOUT,
  pingInterval: CONFIG.PING_INTERVAL,
  serveClient: false,
});

// STATE
const waitingQueue = [];
const activePairs = new Map();
const msgCount = new Map();

// HELPERS
function genAnonId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function checkMsgRate(socketId) {
  const now = Date.now();
  const data = msgCount.get(socketId) || { count: 0, resetAt: now + 60000 };

  if (now > data.resetAt) {
    data.count = 0;
    data.resetAt = now + 60000;
  }

  data.count++;
  msgCount.set(socketId, data);
  return data.count <= CONFIG.MAX_MSGS_MIN;
}

function cleanupUser(socketId) {
  const idx = waitingQueue.indexOf(socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);

  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('partner:left');
    activePairs.delete(partnerId);
  }

  activePairs.delete(socketId);
  msgCount.delete(socketId);
}

function tryMatch(socketId) {
  const idx = waitingQueue.findIndex((id) => id !== socketId);
  if (idx === -1) return false;

  const partnerId = waitingQueue.splice(idx, 1)[0];

  const myIdx = waitingQueue.indexOf(socketId);
  if (myIdx !== -1) waitingQueue.splice(myIdx, 1);

  activePairs.set(socketId, partnerId);
  activePairs.set(partnerId, socketId);

  const myAnonId = genAnonId();
  const partnerAnonId = genAnonId();

  const mySocket = io.sockets.sockets.get(socketId);
  const partnerSocket = io.sockets.sockets.get(partnerId);

  if (mySocket) mySocket.emit('matched', { peerId: partnerAnonId });
  if (partnerSocket) partnerSocket.emit('matched', { peerId: myAnonId });

  console.log(`✅ Match: ${socketId.slice(0, 6)} <-> ${partnerId.slice(0, 6)}`);
  return true;
}

function getStats() {
  return {
    online: io.sockets.sockets.size,
    waiting: waitingQueue.length,
    chatting: activePairs.size / 2,
    uptime: Math.floor(process.uptime()),
  };
}

// ROUTES
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => res.json(getStats()));
app.get('/health', (req, res) => res.json({ status: 'ok', ...getStats() }));

// مهم جداً لـ Railway
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SOCKET EVENTS
io.on('connection', (socket) => {
  console.log(`🔗 Connected: ${socket.id.slice(0, 8)}...`);

  socket.on('find:partner', () => {
    const oldPartner = activePairs.get(socket.id);
    if (oldPartner) {
      const op = io.sockets.sockets.get(oldPartner);
      if (op) op.emit('partner:left');
      activePairs.delete(oldPartner);
      activePairs.delete(socket.id);
    }

    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);

    if (!tryMatch(socket.id)) socket.emit('waiting');
  });

  socket.on('message:send', ({ text } = {}) => {
    if (typeof text !== 'string') return;

    const clean = text.trim().slice(0, CONFIG.MAX_MSG_LEN);
    if (!clean) return;

    if (!checkMsgRate(socket.id)) {
      socket.emit('error:ratelimit', { message: 'أرسلت رسائل كثيرة جداً، انتظر قليلاً ⏳' });
      return;
    }

    const partnerId = activePairs.get(socket.id);
    if (!partnerId) {
      socket.emit('error:nopartner', { message: 'لست في محادثة حالياً' });
      return;
    }

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) return;

    partnerSocket.emit('message:receive', { text: clean, ts: Date.now() });
  });

  socket.on('typing:start', () => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;
    const ps = io.sockets.sockets.get(partnerId);
    if (ps) ps.emit('typing:start');
  });

  socket.on('typing:stop', () => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;
    const ps = io.sockets.sockets.get(partnerId);
    if (ps) ps.emit('typing:stop');
  });

  socket.on('chat:end', () => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const ps = io.sockets.sockets.get(partnerId);
      if (ps) ps.emit('partner:left');
      activePairs.delete(partnerId);
    }
    activePairs.delete(socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.log(`❌ Disconnected: ${socket.id.slice(0, 8)}... reason: ${reason}`);
    cleanupUser(socket.id);
  });

  socket.on('error', (err) => {
    console.error(`⚠️ Socket error ${socket.id.slice(0, 8)}:`, err?.message || err);
  });
});

// STATS BROADCAST
setInterval(() => {
  io.emit('stats:update', getStats());
}, 5000);

// START SERVER
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on PORT=${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  io.emit('server:shutdown', { message: 'السيرفر يُعاد تشغيله قريباً' });
  server.close(() => process.exit(0));
});
