'use strict';
/*
  STANDFADE earn — сервер (Node.js 18+, без внешних библиотек).

  Запуск:   BOT_TOKEN=123456:ABC... node server.js
  Что умеет:
   - отдаёт игру (index.html) по адресу /
   - проверяет подпись Telegram, поэтому подделать ID нельзя
   - промокоды (создаёт только админ, активирует любой игрок один раз)
   - поиск игрока по @юзернейму, бан/разбан, выдача и списание gold
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = String(process.env.ADMIN_ID || '8231559792'); // единственный админ
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const INDEX = path.join(__dirname, 'index.html');

if (!BOT_TOKEN) console.warn('ВНИМАНИЕ: не задан BOT_TOKEN. Промокоды и админка работать не будут.');

/* ---------- простая база в файле ---------- */
let db = { users: {}, promos: {} };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (d && typeof d === 'object') db = { users: d.users || {}, promos: d.promos || {} };
} catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DATA_FILE, () => {}); });
  }, 200);
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const rid = () => crypto.randomBytes(6).toString('hex');

/* ---------- проверка подписи Telegram (initData) ---------- */
function checkInit(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== 'string') return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
  if (!(age >= 0 && age < 86400)) return null; // подпись не старше 24 часов
  try {
    const u = JSON.parse(p.get('user'));
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

/* ---------- ограничение частоты запросов ---------- */
const hits = new Map();
function limit(id, kind, max) {
  const key = id + ':' + kind, now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < 60000);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 300000);

/* ---------- вспомогательное ---------- */
function touch(u, bal) {
  const id = String(u.id);
  let r = own(db.users, id) ? db.users[id] : null;
  if (!r) r = db.users[id] = { id, banned: false, adjs: [], joined: Date.now() };
  r.username = String(u.username || '').toLowerCase();
  r.first_name = String(u.first_name || '').slice(0, 64);
  r.lastSeen = Date.now();
  if (Number.isFinite(bal) && bal >= 0 && bal < 1e15) r.bal = Math.floor(bal);
  return r;
}
const pub = u => ({
  id: u.id, username: u.username || '', first_name: u.first_name || '',
  banned: !!u.banned, bal: Number.isFinite(u.bal) ? u.bal : null,
  lastSeen: u.lastSeen || 0, pending: (u.adjs || []).length
});
const normCode = c => String(c || '').trim().toUpperCase();
const CODE_RE = /^[A-Z0-9_-]{3,24}$/;
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(8)) s += A[b % A.length];
  return s;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 20000) { reject(new Error('big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { const j = JSON.parse(s); resolve(j && typeof j === 'object' ? j : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ---------- API ---------- */
async function handleApi(req, res, route) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const fail = (code, error, message) => send(code, { error, message });

  let body;
  try { body = await readJson(req); } catch (e) { return fail(400, 'bad_json', 'Неверный запрос'); }
  if (!BOT_TOKEN) return fail(500, 'no_token', 'Сервер не настроен (нет BOT_TOKEN)');

  const tu = checkInit(req.headers['x-init-data']);
  if (!tu) return fail(401, 'auth', 'Не удалось подтвердить Telegram. Откройте игру через бота.');
  const id = String(tu.id);
  const isAdmin = id === ADMIN_ID;
  if (!limit(id, 'any', 120)) return fail(429, 'rate', 'Слишком много запросов. Подождите минуту.');

  const me = touch(tu, Number(body.bal));
  save();

  if (route.startsWith('admin/') && !isAdmin) return fail(403, 'forbidden', 'Нет доступа');

  switch (route) {
    case 'me':
      return send(200, { ok: true, banned: !!me.banned, adjs: me.adjs, isAdmin });

    case 'ack': {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      me.adjs = me.adjs.filter(a => !ids.includes(a.id));
      save();
      return send(200, { ok: true });
    }

    case 'promo/redeem': {
      if (me.banned) return fail(403, 'banned', 'Аккаунт заблокирован');
      if (!limit(id, 'promo', 10)) return fail(429, 'rate', 'Слишком много попыток. Подождите минуту.');
      const code = normCode(body.code);
      if (!CODE_RE.test(code) || !own(db.promos, code)) return fail(404, 'nf', 'Промокод не найден');
      const p = db.promos[code];
      if (p.uses.includes(id)) return fail(400, 'used', 'Вы уже активировали этот промокод');
      if (p.uses.length >= p.maxUses) return fail(400, 'limit', 'Лимит активаций промокода исчерпан');
      p.uses.push(id);
      const adj = { id: rid(), amount: p.amount, ts: Date.now(), why: 'promo:' + code };
      me.adjs.push(adj);
      save();
      return send(200, { ok: true, amount: p.amount, adj });
    }

    /* ----- только для админа ----- */
    case 'admin/promo/create': {
      let code = normCode(body.code) || genCode();
      const amount = Math.trunc(Number(body.amount));
      const maxUses = Math.trunc(Number(body.maxUses));
      if (!CODE_RE.test(code)) return fail(400, 'bad', 'Код: 3–24 символа, только A–Z, 0–9, _ и -');
      if (!Number.isFinite(amount) || amount < 1 || amount > 1e9) return fail(400, 'bad', 'Сумма: целое число от 1 до 1 000 000 000');
      if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1e6) return fail(400, 'bad', 'Количество активаций: от 1 до 1 000 000');
      if (own(db.promos, code)) return fail(400, 'exists', 'Такой промокод уже есть');
      db.promos[code] = { code, amount, maxUses, uses: [], created: Date.now() };
      save();
      return send(200, { ok: true, promo: { code, amount, maxUses, used: 0 } });
    }

    case 'admin/promo/list':
      return send(200, {
        ok: true,
        promos: Object.values(db.promos)
          .sort((a, b) => b.created - a.created)
          .map(p => ({ code: p.code, amount: p.amount, maxUses: p.maxUses, used: p.uses.length }))
      });

    case 'admin/promo/delete': {
      const code = normCode(body.code);
      if (!own(db.promos, code)) return fail(404, 'nf', 'Промокод не найден');
      delete db.promos[code];
      save();
      return send(200, { ok: true });
    }

    case 'admin/user/find': {
      const q = String(body.query || '').trim().replace(/^@/, '').toLowerCase();
      if (!q) return fail(400, 'bad', 'Введите @юзернейм или ID');
      let u = own(db.users, q) ? db.users[q] : null;
      if (!u) u = Object.values(db.users).find(x => x.username && x.username === q) || null;
      if (!u) return fail(404, 'nf', 'Игрок не найден. Он должен хотя бы раз открыть игру через Telegram и иметь @юзернейм.');
      return send(200, { ok: true, user: pub(u) });
    }

    case 'admin/user/ban': {
      const uid = String(body.id || '');
      if (!own(db.users, uid)) return fail(404, 'nf', 'Игрок не найден');
      if (uid === ADMIN_ID) return fail(400, 'bad', 'Админа банить нельзя');
      db.users[uid].banned = !!body.banned;
      save();
      return send(200, { ok: true, user: pub(db.users[uid]) });
    }

    case 'admin/user/gold': {
      const uid = String(body.id || '');
      if (!own(db.users, uid)) return fail(404, 'nf', 'Игрок не найден');
      const amount = Math.trunc(Number(body.amount));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e12) return fail(400, 'bad', 'Сумма: целое число, не ноль');
      const u = db.users[uid];
      if (u.adjs.length >= 200) return fail(400, 'bad', 'У игрока слишком много необработанных начислений');
      u.adjs.push({ id: rid(), amount, ts: Date.now(), why: 'admin' });
      save();
      return send(200, { ok: true, user: pub(u) });
    }

    default:
      return fail(404, 'nf', 'Неизвестный запрос');
  }
}

/* ---------- HTTP-сервер ---------- */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Init-Data');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
const server = http.createServer((req, res) => {
  cors(res);
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return fs.readFile(INDEX, (e, d) => {
      if (e) { res.writeHead(404); return res.end('index.html не найден рядом с server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(d);
    });
  }
  if (req.method === 'GET' && url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'POST' && url.startsWith('/api/')) {
    return handleApi(req, res, url.slice(5)).catch(() => {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
      res.end(JSON.stringify({ error: 'server', message: 'Ошибка сервера' }));
    });
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(PORT, () => console.log('STANDFADE earn запущен на порту ' + PORT));
