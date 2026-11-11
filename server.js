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
let db = { users: {}, promos: {}, withdrawals: {}, feed: [], fees: { pending: 0, total: 0 } };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (d && typeof d === 'object') db = { users: d.users || {}, promos: d.promos || {}, withdrawals: d.withdrawals || {}, feed: Array.isArray(d.feed) ? d.feed : [], fees: (d.fees && Number.isFinite(d.fees.pending) && Number.isFinite(d.fees.total)) ? d.fees : { pending: 0, total: 0 } };
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
  if (!(age > -300 && age < 259200)) return null; // подпись не старше 3 суток
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
function touch(u, bal, nick) {
  const id = String(u.id);
  let r = own(db.users, id) ? db.users[id] : null;
  if (!r) r = db.users[id] = { id, banned: false, adjs: [], joined: Date.now() };
  r.username = String(u.username || '').toLowerCase();
  r.first_name = String(u.first_name || '').slice(0, 64);
  r.lastSeen = Date.now();
  if (Number.isFinite(bal) && bal >= 0 && bal < 1e15) r.bal = Math.floor(bal);
  if (typeof nick === 'string') r.nick = nick.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
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
function readJson(req, max = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { const j = JSON.parse(s); resolve(j && typeof j === 'object' ? j : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ---------- онлайн и вывод ---------- */
const MIN_WITHDRAW = 3000;
const TG_API = process.env.TG_API || 'https://api.telegram.org';
function countOnline() {
  const since = Date.now() - 75000; // считаем онлайном тех, кто был на связи последние 75 секунд
  let n = 0;
  for (const u of Object.values(db.users)) if (u.lastSeen > since) n++;
  return n;
}
const escHtml = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FEED_MIN = 500;
const feedList = () => db.feed.slice(-20).reverse().map(f => ({ name: f.name, username: f.username, mode: f.mode, amount: f.amount, ts: f.ts }));

/* вызов Telegram Bot API (без внешних библиотек, работает на любой версии Node) */
function tgCall(method, fields, file) {
  return new Promise((resolve, reject) => {
    const u = new URL(TG_API + '/bot' + BOT_TOKEN + '/' + method);
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    let body, headers;
    if (file) {
      const bd = '----sfe' + crypto.randomBytes(12).toString('hex');
      const parts = [];
      for (const [k, v] of Object.entries(fields)) {
        parts.push(Buffer.from('--' + bd + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + String(v) + '\r\n'));
      }
      parts.push(Buffer.from('--' + bd + '\r\nContent-Disposition: form-data; name="' + file.field + '"; filename="' + file.name + '"\r\nContent-Type: ' + file.type + '\r\n\r\n'));
      parts.push(file.buf);
      parts.push(Buffer.from('\r\n--' + bd + '--\r\n'));
      body = Buffer.concat(parts);
      headers = { 'Content-Type': 'multipart/form-data; boundary=' + bd, 'Content-Length': body.length };
    } else {
      body = Buffer.from(JSON.stringify(fields));
      headers = { 'Content-Type': 'application/json', 'Content-Length': body.length };
    }
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname, method: 'POST', headers, timeout: 20000
    }, res => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (e) {}
        if (j && j.ok) resolve(j);
        else reject(new Error((j && j.description) || ('HTTP ' + res.statusCode)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.end(body);
  });
}
const sendPhotoToAdmin = (buf, mime, caption) => tgCall('sendPhoto',
  { chat_id: ADMIN_ID, caption, parse_mode: 'HTML' },
  { field: 'photo', name: mime === 'image/png' ? 'skin.png' : 'skin.jpg', type: mime, buf });
const sendTextToAdmin = text => tgCall('sendMessage', { chat_id: ADMIN_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });

/* ---------- API ---------- */
async function handleApi(req, res, route) {
  const send = (code, obj) => { req.resume(); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const fail = (code, error, message) => send(code, { error, message });

  if (!BOT_TOKEN) return fail(500, 'no_token', 'Сервер не настроен (нет BOT_TOKEN)');

  const tu = checkInit(req.headers['x-init-data']);
  if (!tu) return fail(401, 'auth', 'Не удалось подтвердить Telegram. Откройте игру через бота.');
  const id = String(tu.id);
  const isAdmin = id === ADMIN_ID;
  if (!limit(id, 'any', 120)) return fail(429, 'rate', 'Слишком много запросов. Подождите минуту.');

  let body;
  try { body = await readJson(req, route === 'withdraw/photo' ? 4000000 : 20000); }
  catch (e) { return fail(400, 'bad_json', 'Неверный запрос или слишком большой файл'); }

  const me = touch(tu, Number(body.bal), body.nick);
  save();

  if (route.startsWith('admin/') && !isAdmin) return fail(403, 'forbidden', 'Нет доступа');

  switch (route) {
    case 'me':
      // комиссия апгрейда (10%) начисляется админу золотом при его заходе в игру
      if (isAdmin && db.fees.pending > 0) {
        me.adjs.push({ id: rid(), amount: db.fees.pending, ts: Date.now(), why: 'commission' });
        db.fees.pending = 0;
        save();
      }
      return send(200, { ok: true, banned: !!me.banned, adjs: me.adjs, isAdmin, online: countOnline(), ver: 5, feed: feedList() });

    case 'ack': {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      me.adjs = me.adjs.filter(a => !ids.includes(a.id));
      save();
      return send(200, { ok: true });
    }

    /* ----- комиссия апгрейда: уходит админу ----- */
    case 'fee': {
      if (!limit(id, 'fee', 60)) return fail(429, 'rate', 'Слишком много запросов');
      const amount = Math.trunc(Number(body.amount));
      if (!Number.isFinite(amount) || amount < 1 || amount > 1e12) return fail(400, 'bad', 'Неверные данные');
      db.fees.pending += amount;
      db.fees.total += amount;
      save();
      return send(200, { ok: true });
    }

    /* ----- лента выигрышей (бегущая строка) ----- */
    case 'feed/add': {
      if (me.banned) return fail(403, 'banned', 'Аккаунт заблокирован');
      if (!limit(id, 'feed', 20)) return fail(429, 'rate', 'Слишком много запросов');
      const mode = String(body.mode || '');
      const amount = Math.trunc(Number(body.amount));
      if (!['case', 'upgrade', 'mines', 'rocket'].includes(mode) || !Number.isFinite(amount) || amount < FEED_MIN || amount > 1e12) {
        return fail(400, 'bad', 'Неверные данные');
      }
      db.feed.push({ id: rid(), name: (me.nick || me.first_name || 'Игрок').slice(0, 20), username: me.username || '', mode, amount, ts: Date.now() });
      if (db.feed.length > 100) db.feed = db.feed.slice(-100);
      save();
      return send(200, { ok: true, feed: feedList() });
    }

    /* ----- сообщение создателю в бота ----- */
    case 'contact': {
      if (!limit(id, 'contact', 5)) return fail(429, 'rate', 'Слишком много сообщений. Подождите минуту.');
      const text = String(body.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 800);
      if (text.length < 2) return fail(400, 'bad', 'Напишите сообщение');
      const name = me.nick || me.first_name || 'Игрок';
      const msg = '✉️ <b>Сообщение от игрока</b>\n'
        + 'Игрок: <a href="tg://user?id=' + id + '">' + escHtml(name) + '</a>' + (me.username ? ' (@' + escHtml(me.username) + ')' : '') + '\n'
        + 'ID: <code>' + id + '</code>\n\n' + escHtml(text);
      try {
        await sendTextToAdmin(msg);
      } catch (e) {
        console.error('contact error:', e.message);
        return fail(502, 'tg', 'Не удалось доставить сообщение. Возможно, создатель ещё не запустил бота. Напишите ему в Telegram напрямую.');
      }
      return send(200, { ok: true });
    }

    /* ----- вывод gold: заявка + фото выставленного скина ----- */
    case 'withdraw/create': {
      if (me.banned) return fail(403, 'banned', 'Аккаунт заблокирован');
      if (!limit(id, 'wd', 10)) return fail(429, 'rate', 'Слишком много попыток. Подождите минуту.');
      const amount = Math.trunc(Number(body.amount));
      if (!Number.isFinite(amount) || amount < MIN_WITHDRAW || amount > 1e12) return fail(400, 'bad', 'Минимальный вывод — ' + MIN_WITHDRAW + ' gold');
      const open = Object.values(db.withdrawals).find(w => w.uid === id && (w.status === 'pending' || w.status === 'sending'));
      if (open) return send(200, { ok: true, existing: true, id: open.id, amount: open.amount, price: open.amount + '.04' });
      const wid = rid();
      db.withdrawals[wid] = { id: wid, uid: id, amount, status: 'pending', created: Date.now() };
      save();
      return send(200, { ok: true, id: wid, amount, price: amount + '.04' });
    }

    case 'withdraw/photo': {
      if (me.banned) return fail(403, 'banned', 'Аккаунт заблокирован');
      if (!limit(id, 'wdp', 6)) return fail(429, 'rate', 'Слишком много попыток. Подождите минуту.');
      const w = own(db.withdrawals, String(body.id)) ? db.withdrawals[String(body.id)] : null;
      if (!w || w.uid !== id) return fail(404, 'nf', 'Заявка не найдена');
      if (w.status === 'sent') return fail(400, 'done', 'Фото по этой заявке уже отправлено');
      if (w.status !== 'pending') return fail(400, 'busy', 'Заявка уже обрабатывается');
      const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
      if (!m) return fail(400, 'bad', 'Нужна фотография (JPG или PNG)');
      const buf = Buffer.from(m[2], 'base64');
      const magicOk = m[1] === 'image/jpeg'
        ? (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
        : (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47);
      if (buf.length < 500 || buf.length > 3000000 || !magicOk) return fail(400, 'bad', 'Не удалось принять фото. Выберите другое изображение.');
      const name = me.nick || me.first_name || 'Игрок';
      const caption = '💸 <b>Заявка на вывод</b> #' + w.id + '\n'
        + 'Игрок: ' + escHtml(name) + (me.username ? ' (@' + escHtml(me.username) + ')' : '') + '\n'
        + 'ID: <code>' + id + '</code>\n'
        + 'Сумма: <b>' + w.amount + ' gold</b>\n'
        + 'Скин выставлен за: <b>' + w.amount + '.04</b>';
      w.status = 'sending'; // защита от двойной отправки
      try {
        await sendPhotoToAdmin(buf, m[1], caption);
      } catch (e) {
        w.status = 'pending';
        console.error('sendPhoto error:', e.message);
        return fail(502, 'tg', 'Не удалось передать фото создателю. Попробуйте ещё раз чуть позже.');
      }
      w.status = 'sent'; w.sentAt = Date.now();
      save();
      return send(200, { ok: true });
    }

    case 'withdraw/cancel': {
      const w = own(db.withdrawals, String(body.id)) ? db.withdrawals[String(body.id)] : null;
      if (!w || w.uid !== id) return fail(404, 'nf', 'Заявка не найдена');
      if (w.status !== 'pending') return fail(400, 'done', 'Эту заявку уже нельзя отменить');
      w.status = 'cancelled';
      const adj = { id: rid(), amount: w.amount, ts: Date.now(), why: 'withdraw-cancel' };
      me.adjs.push(adj);
      save();
      return send(200, { ok: true, adj });
    }

    case 'leaderboard': {
      const list = Object.values(db.users)
        .filter(u => !u.banned && Number.isFinite(u.bal))
        .sort((a, b) => b.bal - a.bal);
      const top = list.slice(0, 20).map(u => ({ name: u.nick || u.first_name || 'Игрок', bal: u.bal, me: u.id === id }));
      const idx = list.findIndex(u => u.id === id);
      return send(200, { ok: true, top, me: { rank: idx >= 0 ? idx + 1 : null, bal: Number.isFinite(me.bal) ? me.bal : 0, total: list.length } });
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
    case 'admin/fees':
      return send(200, { ok: true, total: db.fees.total, pending: db.fees.pending });

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
