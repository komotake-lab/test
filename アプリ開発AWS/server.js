'use strict';

/**
 * WG管理システム サーバー
 *
 *  - index.html / socket.io クライアントの配信
 *  - index.html が参照している API の実装（/api/db-status, /api/login）
 *  - Socket.IO によるリアルタイム同期とデータ永続化
 *
 * index.html 側の作りに合わせてあり、HTML の変更は不要。
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { Store } = require('./store');

const PORT = Number(process.env.PORT || 3000);
const MAX_PAYLOAD_MB = Number(process.env.MAX_PAYLOAD_MB || 25);
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

// index.html のフォールバックユーザーと同じ組み合わせ。
// DB が空のときだけ登録される（保存されるのは bcrypt ハッシュ）。
const SEED_USERS = [
  { username: 'Dabo', email: 'dabo@example.com', password: 'Dabo' },
  { username: 'Kiku', email: 'kiku@example.com', password: 'Kiku' }
];

const store = new Store();
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: MAX_PAYLOAD_MB * 1024 * 1024
});

// ---------- ログイン試行のレート制限（IP + ユーザー名）----------

const loginAttempts = new Map();

function attemptKey(req, username) {
  return `${req.ip}|${String(username).toLowerCase()}`;
}

function isLockedOut(key) {
  const rec = loginAttempts.get(key);
  return Boolean(rec && rec.until > Date.now());
}

function registerFailure(key) {
  const rec = loginAttempts.get(key) || { count: 0, until: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.until = Date.now() + LOGIN_LOCKOUT_MS;
    rec.count = 0;
  }
  loginAttempts.set(key, rec);
}

// ---------- ミドルウェア ----------

app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));
app.use(express.json({ limit: `${MAX_PAYLOAD_MB}mb` }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.static(__dirname, {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-store');
  }
}));

// ---------- API（index.html が呼んでいるもの）----------

// ログイン画面右上のバッジ表示に使われる
app.get('/api/db-status', (req, res) => {
  res.json({ connected: store.connected, storage: store.mode });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = req.body?.password;

  if (!username || !password) {
    return res.json({ success: false, error: 'ユーザー名とパスワードを入力してください' });
  }

  const key = attemptKey(req, username);
  if (isLockedOut(key)) {
    return res.status(429).json({ success: false, error: '試行回数が多すぎます。しばらく待ってから再試行してください' });
  }

  try {
    const user = await store.findUserByUsername(username);
    const ok = user ? await store.verifyPassword(user, password) : false;

    if (!ok) {
      registerFailure(key);
      return res.json({ success: false, error: 'ユーザー名またはパスワードが正しくありません' });
    }

    loginAttempts.delete(key);
    res.json({ success: true, username: user.username });
  } catch (err) {
    console.error('[api] login 失敗:', err);
    res.status(500).json({ success: false, error: '認証処理に失敗しました' });
  }
});

// ---------- Socket.IO ----------

function onlineUsers() {
  return Array.from(io.sockets.sockets.values()).map(s => ({
    id: s.id,
    name: s.data.userName
  }));
}

io.on('connection', (socket) => {
  socket.data.userName = String(socket.handshake.query?.userName || '匿名').slice(0, 40);
  console.log(`[socket] 接続: ${socket.data.userName} (${socket.id})`);

  socket.emit('sync:full', store.getState());
  io.emit('users:online', onlineUsers());

  socket.on('sync:request', () => {
    socket.emit('sync:full', store.getState());
  });

  // 画面側の saveData() が投げる全体更新
  socket.on('data:update', async (data) => {
    try {
      const state = await store.replaceAll(data);
      socket.broadcast.emit('sync:full', state);
    } catch (err) {
      console.error('[socket] data:update 失敗:', err.message);
    }
  });

  // CSV 復元：全クライアントへ再配信する
  socket.on('data:import', async (data) => {
    try {
      const state = await store.replaceAll(data);
      io.emit('sync:full', state);
      socket.broadcast.emit('user:activity', {
        userName: socket.data.userName,
        action: 'バックアップからデータを復元しました'
      });
    } catch (err) {
      console.error('[socket] data:import 失敗:', err.message);
    }
  });

  socket.on('vision:update', async (vision) => {
    try {
      const saved = await store.saveVision(vision);
      socket.broadcast.emit('sync:vision', saved);
    } catch (err) {
      console.error('[socket] vision:update 失敗:', err.message);
    }
  });

  socket.on('item:update', async (item) => {
    try {
      if (!item || !item.id) return;
      const saved = await store.saveItem(item);
      socket.broadcast.emit('sync:item', saved);
    } catch (err) {
      console.error('[socket] item:update 失敗:', err.message);
    }
  });

  socket.on('item:delete', async (itemId) => {
    try {
      if (!itemId) return;
      await store.deleteItem(itemId);
      socket.broadcast.emit('sync:itemDelete', itemId);
    } catch (err) {
      console.error('[socket] item:delete 失敗:', err.message);
    }
  });

  socket.on('minutes:update', async (minute) => {
    try {
      if (!minute || !minute.id) return;
      const saved = await store.saveMinute(minute);
      socket.broadcast.emit('sync:minutes', saved);
    } catch (err) {
      console.error('[socket] minutes:update 失敗:', err.message);
    }
  });

  socket.on('minutes:delete', async (minuteId) => {
    try {
      if (!minuteId) return;
      await store.deleteMinute(minuteId);
      socket.broadcast.emit('sync:minutesDelete', minuteId);
    } catch (err) {
      console.error('[socket] minutes:delete 失敗:', err.message);
    }
  });

  socket.on('user:activity', (activity) => {
    socket.broadcast.emit('user:activity', {
      userName: socket.data.userName,
      action: String(activity?.action || '').slice(0, 120)
    });
  });

  socket.on('disconnect', () => {
    console.log(`[socket] 切断: ${socket.data.userName} (${socket.id})`);
    io.emit('users:online', onlineUsers());
  });
});

// ---------- 起動 ----------

async function seedUsersIfEmpty() {
  if ((await store.countUsers()) > 0) return;

  for (const u of SEED_USERS) {
    await store.createUser(u);
  }
  console.warn('[auth] 初期ユーザー Dabo / Kiku を登録しました。');
  console.warn('[auth] 本番運用の前に必ずパスワードを変更してください（README 参照）。');
}

async function main() {
  await store.init();
  await seedUsersIfEmpty();

  server.listen(PORT, () => {
    console.log(`WG管理システムを起動しました → http://localhost:${PORT}`);
    console.log(`ストレージ: ${store.mode === 'mysql' ? 'MySQL' : 'ファイル (data/store.json)'}`);
  });
}

async function shutdown(signal) {
  console.log(`\n[server] ${signal} を受信。終了します...`);
  io.close();
  server.close();
  try { await store.close(); } catch (e) { /* noop */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(err => {
  console.error('[server] 起動に失敗しました:', err);
  process.exit(1);
});
