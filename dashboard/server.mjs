// 儀表板伺服器：提供網頁與 data.js，並在交易日收盤後自動執行 fetch.mjs 更新資料
//   GET  /               儀表板
//   GET  /data.js        最新資料
//   GET  /api/status     更新狀態
//   POST /api/refresh    立即更新
//   GET  /healthz        健康檢查
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || DIR;
const PORT = +(process.env.PORT || 8080);
const REFRESH_AT = process.env.REFRESH_AT || '17:30';   // 台北時間，週一到週五
const DATA_FILE = path.join(DATA_DIR, 'data.js');

const state = { running: false, lastStart: null, lastEnd: null, lastOk: null, lastError: null, lastRunDay: null };
const log = (...a) => console.log(new Date().toLocaleString('zh-TW', { hour12: false }), ...a);

function refresh(reason) {
  if (state.running) return false;
  state.running = true; state.lastStart = new Date().toISOString(); state.lastError = null;
  log(`開始更新資料（${reason}）`);
  const child = spawn(process.execPath, [path.join(DIR, 'fetch.mjs')], { env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errTail = '';
  child.stdout.on('data', b => process.stdout.write(b));
  child.stderr.on('data', b => { process.stderr.write(b); errTail = (errTail + b).slice(-2000); });
  child.on('close', code => {
    state.running = false; state.lastEnd = new Date().toISOString();
    if (code === 0) { state.lastOk = state.lastEnd; log('資料更新完成'); }
    else { state.lastError = `fetch.mjs 結束代碼 ${code}：${errTail.trim().split('\n').pop() ?? ''}`; log(state.lastError); }
  });
  return true;
}

// 每分鐘檢查一次是否到了排程時間
setInterval(() => {
  const now = new Date(), day = now.getDay();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toLocaleDateString('sv');
  if (day >= 1 && day <= 5 && hm >= REFRESH_AT && state.lastRunDay !== today) {
    state.lastRunDay = today;
    refresh('排程');
  }
}, 60_000);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': TYPES['.json'] }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendFile(res, path.join(DIR, 'index.html'));
  if (req.method === 'GET' && url.pathname === '/vendor/echarts.min.js') return sendFile(res, path.join(DIR, 'vendor', 'echarts.min.js'));
  if (req.method === 'GET' && url.pathname === '/data.js') {
    if (!fs.existsSync(DATA_FILE)) { res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' }); return res.end('window.STOCK_DATA = null;'); }
    return sendFile(res, DATA_FILE);
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const stat = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE) : null;
    return json(res, 200, { ...state, dataUpdatedAt: stat?.mtime ?? null, refreshAt: REFRESH_AT, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }
  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    const started = refresh('手動');
    return json(res, started ? 202 : 409, { started, running: true });
  }
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found');
}).listen(PORT, () => {
  log(`儀表板：http://localhost:${PORT}（資料目錄 ${DATA_DIR}，每個交易日 ${REFRESH_AT} 自動更新）`);
  if (!fs.existsSync(DATA_FILE)) refresh('首次啟動，尚無資料');
});
