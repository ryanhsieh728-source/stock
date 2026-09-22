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

const state = { running: false, lastStart: null, lastEnd: null, lastOk: null, lastError: null, lastRunDay: null, progress: null };
const log = (...a) => console.log(new Date().toLocaleString('zh-TW', { hour12: false }), ...a);

function refresh(reason) {
  if (state.running) return false;
  state.running = true; state.lastStart = new Date().toISOString(); state.lastError = null;
  log(`開始更新資料（${reason}）`);
  const child = spawn(process.execPath, [path.join(DIR, 'fetch.mjs')], { env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errTail = '', outBuf = '';
  state.progress = { done: 0, total: 1, label: '準備中' };
  child.stdout.on('data', b => {
    outBuf += b;
    const lines = outBuf.split('\n'); outBuf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^@@PROGRESS (\d+) (\d+) (.*)$/);
      if (m) state.progress = { done: +m[1], total: +m[2], label: m[3].trim() };
      else process.stdout.write(line + '\n');
    }
  });
  child.stderr.on('data', b => { process.stderr.write(b); errTail = (errTail + b).slice(-2000); });
  child.on('close', code => {
    state.running = false; state.lastEnd = new Date().toISOString(); state.progress = null;
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

// data.js 以「寫暫存檔再改名」更新；在 Windows 的 Docker 掛載資料夾上改名不是瞬間完成，
// 中間可能短暫讀不到檔案。所以保留最後一份讀成功的內容，讀不到時就回傳它，伺服器不會因此出錯
let lastData = null;   // { buf, mtime }
function readData() {
  try {
    const mtime = fs.statSync(DATA_FILE).mtime;
    if (!lastData || +mtime !== +lastData.mtime) lastData = { buf: fs.readFileSync(DATA_FILE), mtime };
  } catch (e) {
    if (e.code !== 'ENOENT') log('讀取 data.js 失敗：' + e.message);
  }
  return lastData;
}

// 任何未預期的錯誤只記錄、不讓整個服務停掉
process.on('uncaughtException', e => log('未預期的錯誤：' + (e.stack || e.message)));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // 允許從本機檔案或其他網址開啟的儀表板呼叫更新 API（只會觸發抓取公開資料）
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendFile(res, path.join(DIR, 'index.html'));
  if (req.method === 'GET' && url.pathname === '/vendor/echarts.min.js') return sendFile(res, path.join(DIR, 'vendor', 'echarts.min.js'));
  if (req.method === 'GET' && url.pathname === '/data.js') {
    const d = readData();
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' });
    return res.end(d ? d.buf : 'window.STOCK_DATA = null;');
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, { ...state, dataUpdatedAt: readData()?.mtime ?? null, refreshAt: REFRESH_AT, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    const started = refresh('手動');
    return json(res, started ? 202 : 409, { started, running: true });
  }
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found');
}).listen(PORT, () => {
  log(`儀表板：http://localhost:${PORT}（資料目錄 ${DATA_DIR}，每個交易日 ${REFRESH_AT} 自動更新）`);
  if (!readData()) refresh('首次啟動，尚無資料');
});
