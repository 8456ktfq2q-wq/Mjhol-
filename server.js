// server.js
'use strict';

const path = require('path');
const http = require('http');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();

/**
 * ✅ Railway / Reverse Proxy fix
 * Required to avoid: ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
 */
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // لأن عندك inline scripts + socket.io client
}));
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

/**
 * ✅ Rate limit (safe behind proxy)
 */
const limiter = rateLimit({
  windowMs: 60 * 1000,     // 1 min
  max: 300,                // عدّلها إذا تبغى
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

/**
 * ✅ Serve static frontend
 * puts /public as root for static files
 */
app.use(express.static(path.join(__dirname, 'public')));

/**
 * ✅ Health + stats endpoints
 */
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

/**
 * Global state
 */
const state = {
  online: 0,
  chatting: 0,
  waiting: new Map(), // socket.id -> { tags: [], at: timestamp }
  peers: new Map(),   // socket.id -> partnerSocketId
};

// helper: return stats
function getStats() {
  return {
    online: state.online,
    chatting: state.chatting,
    waiting: state.waiting.size,
  };
}

app.get('/api/stats', (req, res) => res.json(getStats()));

// ✅ Root route: serve the SPA/main page (in case of refresh)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Create HTTP server + Socket.IO
 */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
  transports: ['websocket', 'polling'], // ✅ عشان ما يطلع Transport unknown
  allowEIO3: true,
});

function broadcastStats() {
  io.emit('stats:update', {
    online: state.online,
    chatting: state.chatting,
  });
}

/**
 * Matchmaking helpers
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 10);
}

function haveCommonTag(aTags, bTags) {
  if (!aTags.length || !bTags.length) return false;
  const setA = new Set(aTags);
  return bTags.some(t => setA.has(t));
}

function isChatting(socketId) {
  return state.peers.has(socketId);
}

function endChat(socketId, notifyPartner = true) {
  const partnerId = state.peers.get(socketId);
  if (partnerId) {
    state.peers.delete(socketId);
    state.peers.delete(partnerId);
    state.chatting = Math.max(0, state.chatting - 2);

    if (notifyPartner) {
      const partnerSock = io.sockets.sockets.get(partnerId);
      if (partnerSock) partnerSock.emit('partner:left');
    }
  }
  broadcastStats();
}

function removeFromQueue(socketId) {
  if (state.waiting.has(socketId)) {
    state.waiting.delete(socketId);
  }
}

function tryMatch(socket, tags) {
  // لا تطابق لو هو أصلاً في شات
  if (isChatting(socket.id)) return;

  // ابحث عن شخص ثاني في الانتظار
  let chosenId = null;

  for (const [otherId, otherInfo] of state.waiting.entries()) {
    if (otherId === socket.id) continue;
    if (isChatting(otherId)) continue;

    // إذا الطرفين عندهم tags: حاول تطابق حسب اهتمامات مشتركة
    const ok =
      (tags.length === 0 && otherInfo.tags.length === 0) ||
      (tags.length === 0) ||
      (otherInfo.tags.length === 0) ||
      haveCommonTag(tags, otherInfo.tags);

    if (ok) {
      chosenId = otherId;
      break;
    }
  }

  if (!chosenId) {
    // ما فيه أحد مناسب -> خله ينتظر
    state.waiting.set(socket.id, { tags, at: Date.now() });
    socket.emit('waiting');
    broadcastStats();
    return;
  }

  // طابقهم
  const otherSocket = io.sockets.sockets.get(chosenId);
  if (!otherSocket) {
    state.waiting.delete(chosenId);
    // حاول مرة ثانية
    return tryMatch(socket, tags);
  }

  // شيل الاثنين من الانتظار
  state.waiting.delete(chosenId);
  state.waiting.delete(socket.id);

  // اربطهم
  state.peers.set(socket.id, chosenId);
  state.peers.set(chosenId, socket.id);

  state.chatting += 2;

  const peerIdA = String(Math.floor(Math.random() * 9000) + 1000);
  const peerIdB = String(Math.floor(Math.random() * 9000) + 1000);

  socket.emit('matched', { peerId: peerIdA });
  otherSocket.emit('matched', { peerId: peerIdB });

  broadcastStats();
}

/**
 * Socket.IO events
 */
io.on('connection', (socket) => {
  state.online += 1;
  broadcastStats();

  // send initial stats
  socket.emit('stats:update', { online: state.online, chatting: state.chatting });

  socket.on('find:partner', (payload = {}) => {
    const tags = normalizeTags(payload.tags);

    // إذا كان في شات، انهي القديم
    if (isChatting(socket.id)) endChat(socket.id, true);

    // شيله من الانتظار (لو كان موجود)
    removeFromQueue(socket.id);

    tryMatch(socket, tags);
  });

  socket.on('message:send', (payload = {}) => {
    const text = String(payload.text || '').trim();
    if (!text) return;

    const partnerId = state.peers.get(socket.id);
    if (!partnerId) {
      socket.emit('error:noparter');
      return;
    }

    const partnerSock = io.sockets.sockets.get(partnerId);
    if (!partnerSock) return;

    partnerSock.emit('message:receive', { text, ts: Date.now() });
  });

  socket.on('typing:start', () => {
    const partnerId = state.peers.get(socket.id);
    if (!partnerId) return;
    const partnerSock = io.sockets.sockets.get(partnerId);
    if (!partnerSock) return;
    partnerSock.emit('typing:start');
  });

  socket.on('typing:stop', () => {
    const partnerId = state.peers.get(socket.id);
    if (!partnerId) return;
    const partnerSock = io.sockets.sockets.get(partnerId);
    if (!partnerSock) return;
    partnerSock.emit('typing:stop');
  });

  socket.on('chat:end', () => {
    // انهِ محادثته إذا موجودة
    endChat(socket.id, true);
    // وطلّعه من الانتظار
    removeFromQueue(socket.id);
  });

  socket.on('disconnect', () => {
    // إذا كان ينتظر
    removeFromQueue(socket.id);

    // إذا كان في محادثة
    endChat(socket.id, true);

    state.online = Math.max(0, state.online - 1);
    broadcastStats();
  });
});

/**
 * Start server (Railway-friendly)
 */
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on PORT=${PORT}`);
});
