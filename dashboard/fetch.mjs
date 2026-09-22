// 從 TWSE / TPEx 公開 API 抓取日 K 與三大法人資料，輸出 data.js 供儀表板使用
// 用法：node fetch.mjs   （原始回應快取在 $DATA_DIR/cache/，重跑只補抓缺的）
// DATA_DIR 預設為本檔所在目錄；Docker 內為 /data
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || DIR;
const CACHE = path.join(DATA_DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

export const STOCKS = [
  { code: '4958', name: '臻鼎-KY', market: 'TWSE' },
  { code: '1303', name: '南亞', market: 'TWSE' },
  { code: '2408', name: '南亞科', market: 'TWSE' },
  { code: '2368', name: '金像電', market: 'TWSE' },
  { code: '8046', name: '南電', market: 'TWSE' },
  { code: '3037', name: '欣興', market: 'TWSE' },
  { code: '3189', name: '景碩', market: 'TWSE' },
  { code: '8021', name: '尖點', market: 'TWSE' },
  { code: '8358', name: '金居', market: 'TPEx' },
  { code: '2455', name: '全新', market: 'TWSE' },
  { code: '6173', name: '信昌電', market: 'TPEx' },
  { code: '6182', name: '合晶', market: 'TPEx' },
];
const MONTHS = 7;          // 日 K 抓幾個月（MA60 需要暖機）
const INST_DAYS = 60;      // 法人資料天數
const DELAY = 2500;        // TWSE 有頻率限制，每次請求間隔

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const v = parseFloat(String(s ?? '').replace(/[,\s+]/g, '')); return Number.isFinite(v) ? v : null; };
const rocToIso = s => { const [y, m, d] = s.trim().split('/'); return `${+y + 1911}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };

async function getJson(key, url, isComplete) {
  const file = path.join(CACHE, key + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(DELAY);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (isComplete(json)) fs.writeFileSync(file, JSON.stringify(json));   // 只快取完整的過去資料
      return json;
    } catch (e) {
      console.warn(`  ! ${key} 第 ${attempt} 次失敗：${e.message}`);
      await sleep(DELAY * attempt * 2);
    }
  }
  return null;
}

function monthList(n) {
  const out = [], now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }
  return out;
}
// 以本地時區（容器設 TZ=Asia/Taipei）判斷當月與今天
const now = new Date(), p2 = n => String(n).padStart(2, '0');
const curMonth = `${now.getFullYear()}${p2(now.getMonth() + 1)}`;
const today = `${curMonth}${p2(now.getDate())}`;

async function fetchDaily(stock) {
  const rows = [];
  for (const { y, m } of monthList(MONTHS)) {
    const ym = `${y}${String(m).padStart(2, '0')}`;
    const past = ym !== curMonth;
    let data = [];
    if (stock.market === 'TWSE') {
      const j = await getJson(`day_${stock.code}_${ym}`,
        `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${stock.code}&response=json`,
        j => past && j.stat === 'OK');
      if (j?.stat === 'OK') data = j.data.map(r => ({ d: r[0], vol: num(r[1]) / 1000, amt: num(r[2]), o: r[3], h: r[4], l: r[5], c: r[6], n: num(r[8]) }));
    } else {
      const j = await getJson(`day_${stock.code}_${ym}`,
        `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${stock.code}&date=${y}/${String(m).padStart(2, '0')}/01&response=json`,
        j => past && j.tables?.[0]?.data?.length);
      data = (j?.tables?.[0]?.data ?? []).map(r => ({ d: r[0], vol: num(r[1]), amt: num(r[2]) * 1000, o: r[3], h: r[4], l: r[5], c: r[6], n: num(r[8]) }));
    }
    for (const r of data) {
      const [o, h, l, c] = [num(r.o), num(r.h), num(r.l), num(r.c)];
      if (c == null || o == null) continue;          // 無成交日（價格 "--"）跳過
      rows.push({ date: rocToIso(r.d), o, h, l, c, v: Math.round(r.vol), amt: r.amt, n: r.n });
    }
  }
  return rows;
}

// 一個日期一次請求，回傳全市場，所以依日期抓再分配給各檔
async function fetchInstTWSE(date) {
  const j = await getJson(`t86_${date}`,
    `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALLBUT0999&response=json`,
    j => j.stat === 'OK' && date !== today);
  if (j?.stat !== 'OK') return null;
  const f = j.fields, idx = name => f.findIndex(x => x === name);
  const iF = idx('外陸資買賣超股數(不含外資自營商)'), iFD = idx('外資自營商買賣超股數'),
        iT = idx('投信買賣超股數'), iD = idx('自營商買賣超股數'), iAll = idx('三大法人買賣超股數');
  const map = {};
  for (const r of j.data) map[r[0].trim()] = {
    foreign: (num(r[iF]) + (num(r[iFD]) ?? 0)) / 1000, trust: num(r[iT]) / 1000, dealer: num(r[iD]) / 1000, total: num(r[iAll]) / 1000,
  };
  return map;
}
async function fetchInstTPEx(date) {
  const ds = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6)}`;
  const j = await getJson(`tpexinst_${date}`,
    `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${ds}&response=json`,
    j => j.tables?.[0]?.data?.length && date !== today);
  const data = j?.tables?.[0]?.data;
  if (!data?.length) return null;
  const map = {};
  // 欄位：代號,名稱,外資(不含自營)買/賣/超,外資自營買/賣/超,外資合計買/賣/超,投信買/賣/超,自營自行買/賣/超,自營避險買/賣/超,自營合計買/賣/超,三大法人合計
  for (const r of data) map[r[0].trim()] = {
    foreign: num(r[10]) / 1000, trust: num(r[13]) / 1000, dealer: num(r[22]) / 1000, total: num(r[23]) / 1000,
  };
  return map;
}

// 證交所即時報價（上市、上櫃都支援，一次查全部）。盤中或日 K 尚未公布時，用它補上當天的 K 棒
// 盤中 z（成交價）只在最近 5 秒有成交時才有值，其餘為 "-"：最多重抓 3 次，仍沒有就用最佳買價
async function fetchLive() {
  const ex = STOCKS.map(s => `${s.market === 'TPEx' ? 'otc' : 'tse'}_${s.code}.tw`).join('|');
  const map = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(attempt ? 1500 : DELAY);
    try {
      const res = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(ex)}&json=1&delay=0&_=${Date.now()}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/stock/index.jsp' } });
      const j = await res.json();
      for (const r of j.msgArray ?? []) {
        if (!r.d || map[r.c]?.src === 'trade') continue;
        // 五檔裡的 0.0000 代表市價單（漲停／跌停鎖住時常見），不是價格，取第一個正數
        const pos = x => { const v = num(x); return v > 0 ? v : null; };
        const firstPos = s => String(s ?? '').split('_').map(pos).find(v => v != null) ?? null;
        const trade = pos(r.z) ?? pos(r.pz), bid = firstPos(r.b), ask = firstPos(r.a);
        const c = trade ?? bid ?? ask;
        if (c == null) continue;
        map[r.c] = { date: `${r.d.slice(0, 4)}-${r.d.slice(4, 6)}-${r.d.slice(6)}`, time: r.t, src: trade != null ? 'trade' : bid != null ? 'bid' : 'ask',
          o: pos(r.o) ?? c, h: Math.max(pos(r.h) ?? c, c), l: Math.min(pos(r.l) ?? c, c), c, v: num(r.v) ?? 0 };
      }
    } catch (e) {
      console.warn('  ! 即時報價失敗：' + e.message);
    }
    if (STOCKS.every(s => map[s.code]?.src === 'trade')) break;
  }
  return map;
}

// 讓 server.mjs 顯示進度：@@PROGRESS 已完成 總數 說明
const progress = (done, total, label) => console.log(`@@PROGRESS ${done} ${total} ${label}`);

async function main() {
  const out = { generatedAt: new Date().toISOString(), stocks: [] };
  const daily = {};
  const total = STOCKS.length + 1 + INST_DAYS;
  let step = 0;
  for (const s of STOCKS) {
    progress(step, total, `日 K ${s.name}`);
    console.log(`日 K：${s.code} ${s.name}`);
    daily[s.code] = await fetchDaily(s);
    console.log(`  ${daily[s.code].length} 筆，最後 ${daily[s.code].at(-1)?.date}`);
    step++;
  }
  // 法人日期以正式日 K 為準（不含盤中 K 棒）
  const dates = daily['2408'].map(r => r.date).slice(-INST_DAYS);

  progress(step, total, '即時報價');
  const live = await fetchLive();
  for (const s of STOCKS) {
    const q = live[s.code], rows = daily[s.code];
    if (q && q.date > (rows.at(-1)?.date ?? '')) {
      rows.push({ date: q.date, o: q.o, h: q.h, l: q.l, c: q.c, v: Math.round(q.v), amt: null, n: null, live: true, time: q.time, src: q.src });
      console.log(`  ${s.name} 補上即時 K 棒 ${q.date} ${q.time} ${{ trade: '成交價', bid: '買價', ask: '賣價' }[q.src]} ${q.c}`);
    }
  }
  step++;

  const inst = {};
  for (const iso of dates) {
    const d = iso.replace(/-/g, '');
    progress(step++, total, `法人 ${iso.slice(5)}`);
    const [tw, tp] = [await fetchInstTWSE(d), await fetchInstTPEx(d)];
    inst[iso] = { ...(tw ?? {}), ...(tp ?? {}) };
  }
  progress(total, total, '寫入資料');
  for (const s of STOCKS) {
    const rows = daily[s.code];
    const instRows = dates.map(date => ({ date, ...(inst[date]?.[s.code] ?? {}) })).filter(r => r.total != null);
    out.stocks.push({ ...s, daily: rows, inst: instRows });
    console.log(`${s.code} ${s.name}：日K ${rows.length} 日，法人 ${instRows.length}/${dates.length} 日`);
  }
  // 先寫暫存檔再改名，避免網頁讀到寫一半的檔案
  const target = path.join(DATA_DIR, 'data.js');
  fs.writeFileSync(target + '.tmp', 'window.STOCK_DATA = ' + JSON.stringify(out) + ';\n');
  fs.renameSync(target + '.tmp', target);
  console.log('已輸出 data.js');
}
main().catch(e => { console.error(e); process.exit(1); });
