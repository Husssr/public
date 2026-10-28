'use strict';
// SyncDesk Windows helper
// ทำให้คลิปบอร์ดของ Windows ซิงก์กับห้องอัตโนมัติ และรับคำสั่งรีโมต (ลูกศร / Space) ไปยังหน้าต่างที่เปิดอยู่
// usage: node win-helper.js https://your-app.onrender.com ROOM SECRET

const { execFile } = require('child_process');
const WebSocket = require('ws');

const [, , base, room, secret] = process.argv;
if (!base || !room || !secret) {
  console.log('usage: node win-helper.js <url> <room> <secret>');
  process.exit(1);
}

const wsUrl = base.replace(/^http/, 'ws').replace(/\/$/, '') +
  `/ws?r=${room}&k=${secret}&name=${encodeURIComponent('Windows Helper')}&kind=laptop`;

const ps = (script, env = {}) => new Promise((resolve) => {
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    (err, out) => resolve(err ? null : out));
});

const readClipboard = () => ps(
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }"
);
const writeClipboard = (text) => ps('Set-Clipboard -Value $env:SD_TEXT', { SD_TEXT: text });
const sendKey = (key) => ps(
  "(New-Object -ComObject WScript.Shell).SendKeys($env:SD_KEY)", { SD_KEY: key }
);

const KEY_MAP = { '◀': '{LEFT}', '▶': '{RIGHT}', '⏯': ' ', '⏸': ' ' };

let ws = null;
let lastClip = null;   // last text we know is in sync, prevents echo loops
let busy = false;
let retry = 0;

function connect() {
  console.log('กำลังเชื่อมต่อห้อง...');
  ws = new WebSocket(wsUrl);
  ws.on('open', () => { retry = 0; console.log('✅ เชื่อมต่อแล้ว คัดลอกบน Windows ได้เลย'); });
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'clip' && typeof m.text === 'string' && m.text !== lastClip) {
      lastClip = m.text;
      await writeClipboard(m.text);
      console.log(`📥 รับจาก ${m.from}: ${m.text.slice(0, 60)}`);
    } else if (m.type === 'remote') {
      const k = KEY_MAP[m.key];
      if (k) { await sendKey(k); console.log(`🎮 คำสั่ง ${m.key} จาก ${m.from}`); }
    }
  });
  ws.on('close', () => {
    retry++;
    const wait = Math.min(15000, 1000 * 2 ** Math.min(retry, 4));
    console.log(`⚠️ ขาดการเชื่อมต่อ ลองใหม่ใน ${wait / 1000} วินาที`);
    setTimeout(connect, wait);
  });
  ws.on('error', () => {});
}

// Poll Windows clipboard and push changes
setInterval(async () => {
  if (busy || !ws || ws.readyState !== WebSocket.OPEN) return;
  busy = true;
  try {
    const t = await readClipboard();
    if (t && t !== lastClip && t.length < 200000) {
      lastClip = t;
      ws.send(JSON.stringify({ type: 'clip', text: t }));
      console.log(`📤 ส่ง: ${t.slice(0, 60)}`);
    }
  } finally { busy = false; }
}, 1200);

connect();
