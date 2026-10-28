'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(__dirname, 'uploads');
const MAX_FILE = 200 * 1024 * 1024;
const FILE_TTL = 60 * 60 * 1000;
const MAX_HISTORY = 30;
fs.mkdirSync(UPLOADS, { recursive: true });

const rooms = new Map();   // roomId -> { id, secret, clients: Map, history: [], lastSeen }
const files = new Map();   // fileId -> { path, name, size, expires }
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml'
};

const rand = (n) => crypto.randomBytes(n).toString('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const baseUrl = (req) => {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
};
const authRoom = (id, secret) => {
  const room = rooms.get(id);
  return room && secret && safeEq(room.secret, secret) ? room : null;
};
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (room, obj, exceptId) => {
  for (const [id, c] of room.clients) if (id !== exceptId) send(c.ws, obj);
};
const pushHistory = (room, item) => {
  room.history.push(item);
  if (room.history.length > MAX_HISTORY) room.history.shift();
};
const pushDevices = (room) => {
  const list = [...room.clients.values()].map(c => ({ id: c.id, name: c.name, kind: c.kind }));
  for (const c of room.clients.values()) send(c.ws, { type: 'devices', list, you: c.id });
};

// Cleanup: expired files, idle rooms (no devices for 24h)
setInterval(() => {
  const now = Date.now();
  for (const [id, f] of files) if (f.expires < now) { fs.rm(f.path, () => {}); files.delete(id); }
  for (const [id, r] of rooms) if (r.clients.size === 0 && now - r.lastSeen > 24 * 3600e3) rooms.delete(id);
}, 60e3).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Create a new room + QR pairing code
    if (req.method === 'GET' && url.pathname === '/api/new-room') {
      const id = rand(6), secret = rand(16);
      rooms.set(id, { id, secret, clients: new Map(), history: [], lastSeen: Date.now() });
      const pair = `${baseUrl(req)}/?r=${id}&k=${secret}`;
      const qr = await QRCode.toDataURL(pair, { margin: 1, width: 240, color: { dark: '#111111', light: '#ffffff' } });
      return json(res, 200, { id, secret, pair, qr });
    }

    // Rebuild QR for an existing pairing URL (only for our own origin)
    if (req.method === 'GET' && url.pathname === '/api/qr') {
      const u = url.searchParams.get('u') || '';
      if (!u.startsWith(baseUrl(req) + '/?r=')) return json(res, 400, { error: 'bad url' });
      const qr = await QRCode.toDataURL(u, { margin: 1, width: 240, color: { dark: '#111111', light: '#ffffff' } });
      return json(res, 200, { qr });
    }

    // Upload a file (streamed to disk) and broadcast to the room
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const room = authRoom(url.searchParams.get('r'), url.searchParams.get('k'));
      if (!room) return json(res, 401, { error: 'unauthorized' });
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_FILE) return json(res, 413, { error: 'ไฟล์ใหญ่เกิน 200 MB' });

      const name = (url.searchParams.get('name') || 'file').replace(/[^\w.\- \u0E00-\u0E7F()]/g, '_').slice(0, 120);
      const fileId = rand(12);
      const p = path.join(UPLOADS, fileId);
      const out = fs.createWriteStream(p);
      let written = 0;
      try {
        for await (const chunk of req) {
          written += chunk.length;
          if (written > MAX_FILE) throw new Error('too large');
          if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        }
        await new Promise(r => out.end(r));
      } catch (e) {
        out.destroy(); fs.rm(p, () => {});
        return json(res, 413, { error: 'อัปโหลดไม่สำเร็จ' });
      }
      files.set(fileId, { path: p, name, size: written, expires: Date.now() + FILE_TTL });
      room.lastSeen = Date.now();
      const meta = {
        type: 'file', id: fileId, name, size: written,
        url: `/f/${fileId}`, from: (url.searchParams.get('from') || 'อุปกรณ์').slice(0, 40), at: Date.now()
      };
      pushHistory(room, meta);
      broadcast(room, meta);
      return json(res, 200, meta);
    }

    // Download a file
    if (req.method === 'GET' && url.pathname.startsWith('/f/')) {
      const f = files.get(url.pathname.slice(3));
      if (!f) return json(res, 404, { error: 'ไม่พบไฟล์ (อาจหมดอายุแล้ว)' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': f.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`
      });
      return fs.createReadStream(f.path).pipe(res);
    }

    // Static files
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const p = path.normalize(path.join(PUBLIC, rel));
    if (!p.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(p, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: 'server error' });
  }
});

// WebSocket: real-time clipboard, remote keys, device presence
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const room = authRoom(url.searchParams.get('r'), url.searchParams.get('k'));
  if (!room) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const id = rand(5);
    const client = {
      id, ws,
      name: (url.searchParams.get('name') || 'เครื่อง').slice(0, 40),
      kind: url.searchParams.get('kind') || 'laptop'
    };
    room.clients.set(id, client);
    room.lastSeen = Date.now();
    send(ws, { type: 'history', items: room.history });
    pushDevices(room);

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      room.lastSeen = Date.now();
      if (m.type === 'clip' && typeof m.text === 'string' && m.text.length > 0 && m.text.length < 200000) {
        const item = { type: 'clip', text: m.text, from: client.name, fromId: id, at: Date.now() };
        pushHistory(room, item);
        broadcast(room, item, id);
      } else if (m.type === 'remote' && typeof m.key === 'string') {
        const target = room.clients.get(m.target);
        if (target) send(target.ws, { type: 'remote', key: m.key.slice(0, 20), from: client.name });
      }
    });
    ws.on('close', () => { room.clients.delete(id); pushDevices(room); });
  });
});

server.listen(PORT, () => console.log(`SyncDesk running on http://localhost:${PORT}`));
