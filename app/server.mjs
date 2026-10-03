// 最小学习循环的本地服务：零依赖（node:http + node:sqlite）。
//   node app/server.mjs           默认 http://127.0.0.1:8777
//   PORT=8000 node app/server.mjs
//
// 页面是仓库里原有的 tools/index.html —— 那份原型一个字都没改，
// 本文件只提供 bundle 静态文件 + 存档接口（见 D17）。
//
// 职责边界：HTTP + SQLite。SRS 算在 app/srs.mjs，落在 data/user.db。
// 练习队列不在服务端：tools/index.html 自己管（原来在 localStorage，
// 现在镜像一份到 SQLite 的 ui_state 表）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.mjs';
import { loadParams } from './srs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJ = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8777);

const params = loadParams();
const bundle = store.loadBundle();
const db = store.openDb();
const n = store.syncBundle(db, bundle);

function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

const routes = {
  /** 首页要的几个数（也用于 verify / 调试） */
  async '/api/bootstrap'(req, res) {
    json(res, 200, {
      bundle: bundle.stats,
      cards: bundle.cards.length,
      overview: store.overview(db, params),
    });
  },

  async '/api/overview'(req, res) {
    json(res, 200, store.overview(db, params));
  },

  /**
   * tools/index.html 的 state 镜像。
   *   GET  启动时读：本地 localStorage 为空时用它恢复
   *   POST 每次 saveState() 推一份上来：清缓存/换机器后能找回
   * 前端仍以 localStorage 为准，这里不做权威，只做备份 + 跨设备副本。
   */
  async '/api/ui-state'(req, res) {
    if (req.method === 'GET') {
      json(res, 200, store.loadUiState(db) || { state: null, ts: 0 });
      return;
    }
    const { state } = await readBody(req);
    if (!state || typeof state !== 'object') { json(res, 400, { error: 'bad state' }); return; }
    store.saveUiState(db, state);
    json(res, 200, { ok: true });
  },

  /** 记一次作答，SRS 在服务端算，落在 card_state / review_log */
  async '/api/answer'(req, res) {
    const { word, senseId, result, elapsedMs } = await readBody(req);
    if (!['CORRECT', 'WRONG', 'PENDING'].includes(result)) {
      json(res, 400, { error: 'bad result' });
      return;
    }
    try {
      json(res, 200, store.recordAnswer(db, params, bundle,
        { word, senseId, result, elapsedMs }));
    } catch (e) {
      json(res, 400, { error: String((e && e.message) || e) });
    }
  },

  /** 用户手动标「我已学会」/ 取消 */
  async '/api/mastered'(req, res) {
    const { word, senseId, on } = await readBody(req);
    try {
      json(res, 200, store.setMastered(db, params, bundle, word, senseId, !!on));
    } catch (e) {
      json(res, 400, { error: String((e && e.message) || e) });
    }
  },

  /** 学过的题：最近 n 条作答流水。 */
  async '/api/history'(req, res) {
    const n = Number((new URL(req.url, 'http://x').searchParams.get('n')) || 60);
    json(res, 200, { history: store.history(db, bundle, Math.min(n, 200)) });
  },

  /**
   * 本轮队列。到期卡按 SRS 权重排序（03 §5.2），
   * 并剔除已被标记的问题句 —— 前端拿不到该出的题。
   * 前端 pickQueue() 拿不到它时退回自己的排法（离线 / 纯静态打开）。
   */
  async '/api/queue'(req, res) {
    const { n } = await readBody(req);
    json(res, 200, store.queue(db, bundle, params, Math.min(Number(n) || 20, 200)));
  },

  /** 这句有问题。标完立刻退出出题池，备注可空。 */
  async '/api/flag'(req, res) {
    const { word, senseId, sentence, note } = await readBody(req);
    try {
      json(res, 200, store.flagSentence(db, bundle, { word, senseId, sentence, note }));
    } catch (e) {
      json(res, 400, { error: String((e && e.message) || e) });
    }
  },

  /** 已标记的问题清单，scripts/triage_flags.py 也读这张表。 */
  async '/api/flags'(req, res) {
    json(res, 200, { total: store.flaggedCount(db), flags: store.listFlags(db) });
  },

  /** 只清 UI 存档，不动 SRS 与标记 —— 想「重开一轮但保留记忆曲线」时用 */
  async '/api/reset-ui'(req, res) {
    store.clearUiState(db);
    json(res, 200, { ok: true });
  },
};

// ── 静态文件：只服务仓库里已有的文件，不做目录穿越 ──────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  // 原来的原型在 tools/ 下，保持那个路径可用，同时把 / 指到它
  const rel = pathname === '/' || pathname === '/index.html'
    ? 'tools/index.html'
    : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const abs = path.resolve(PROJ, rel);
  if (!abs.startsWith(path.resolve(PROJ)) || !fs.existsSync(abs)
      || !fs.statSync(abs).isFile()) {
    json(res, 404, { error: 'not found: ' + pathname });
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(fs.readFileSync(abs));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[url.pathname];
  if (route) {
    try {
      await route(req, res);
    } catch (e) {
      json(res, 500, { error: String((e && e.message) || e) });
    }
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  const ov = store.overview(db, params);
  console.log(`页面      : http://127.0.0.1:${PORT}/  (tools/index.html，未改动)`);
  console.log(`card 投影 : ${n} 张（bundle ${bundle.version}）`);
  console.log(`可练 ${ov.pool} / 到期 ${ov.due} / 已掌握 ${ov.mastered} / 错题 ${ov.wrong}`);
  console.log(`user.db   : ${store.USER_DB}`);
});