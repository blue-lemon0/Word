// 最小学习循环的本地服务：零依赖（node:http + node:sqlite）。
//   node app/server.mjs           默认 http://127.0.0.1:8777
//   PORT=9000 node app/server.mjs
//
// 职责边界：HTTP + 会话队列。SRS 算在 app/srs.mjs，落在 data/user.db。
// 队列本身不入库 —— 关掉浏览器再打开，队列从 v_due 重新算，进度一条不少。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.mjs';
import { loadParams } from './srs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8777);
const SESSION_SIZE = Number(process.env.SESSION_SIZE || 20);

const params = loadParams();
const bundle = store.loadBundle();
const db = store.openDb();
const n = store.syncBundle(db, bundle);

const sessions = new Map();

function newQueue(nowSec) {
  const rows = store.layout(db, params, SESSION_SIZE, nowSec);
  return rows.map((r) => ({ word: r.word, sense_id: r.sense_id }));
}

function newSession(id) {
  const s = {
    id, queue: newQueue(store.now()), idx: 0, served: 0,
    attempt: null, asked: 0, correct: 0, wrong: 0, pending: 0,
  };
  sessions.set(id, s);
  return s;
}

function getSession(id) {
  return sessions.get(id) || newSession(id);
}

function currentCard(s, bundleRef) {
  while (s.idx < s.queue.length) {
    const item = s.queue[s.idx];
    const card = bundleRef.cards.find((c) => c.w === item.word && c.s === item.sense_id);
    if (card && card.rows.length) return { item, card };
    s.idx++;                      // 该卡没句子（句子还没生成），跳过
  }
  return null;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const routes = {
  async '/api/bootstrap'(req, res) {
    json(res, 200, {
      bundle: bundle.stats,
      cards: bundle.cards.length,
      sessionSize: SESSION_SIZE,
      overview: store.overview(db, params),
    });
  },

  async '/api/overview'(req, res) {
    json(res, 200, store.overview(db, params));
  },

  async '/api/start'(req, res) {
    const { sessionId } = await readBody(req);
    const id = sessionId || `s${Date.now().toString(36)}`;
    sessions.delete(id);
    const s = getSession(id);
    json(res, 200, {
      sessionId: id,
      total: s.queue.length,
      overview: store.overview(db, params),
    });
  },

  async '/api/next'(req, res) {
    const { sessionId, sentIdx } = await readBody(req);
    const s = getSession(sessionId);
    if (sentIdx != null) s.idx = sentIdx;
    const hit = currentCard(s, bundle);
    if (!hit) {
      json(res, 200, { done: true, summary: summary(s), overview: store.overview(db, params) });
      return;
    }
    const sent = store.pickSentence(bundle, hit.item.word, hit.item.sense_id, s.asked);
    // 每出一道题发一个 attempt_id：客户端作答时带回，同一次出题的重复提交
    // 会被 review_log 的唯一索引折叠掉。
    s.served += 1;
    s.attempt = `${s.id}#${s.served}`;
    json(res, 200, {
      done: false,
      total: s.queue.length,
      position: s.idx + 1,
      attemptId: s.attempt,
      word: hit.card.w,
      pos: hit.card.pos,
      senseId: hit.card.s,
      tier: hit.card.tier,
      sentence: sent,
      options: store.buildOptions(bundle, hit.card, 4),
    });
  },

  async '/api/answer'(req, res) {
const body = await readBody(req);
    const { sessionId, attemptId, word, senseId, picked, elapsedMs, isDue } = body;
    const s = getSession(sessionId);
    const card = bundle.cards.find((c) => c.w === word && c.s === senseId);
    if (!card) { json(res, 400, { error: 'unknown card' }); return; }
    // 只接受「当前这道题」的 attempt。同一 attempt 的重发走到下面被唯一索引折叠；
    // 换了别的 attempt 说明客户端拿着上一题的答案乱交，直接拒。
    if (!s.attempt || attemptId !== s.attempt) {
      json(res, 409, { error: 'stale attempt', currentAttempt: s.attempt });
      return;
    }

    const result = picked === '__PENDING__' ? 'PENDING'
      : picked === card.zh ? 'CORRECT' : 'WRONG';
    const out = store.commitAnswer(db, params, bundle, {
      sessionId, idx: s.idx, attemptId, word, senseId, result, elapsedMs,
      isDue: isDue === false ? 0 : 1,
    });

    if (out.applied) {
      s.asked++;
      if (result === 'CORRECT') s.correct++;
      else if (result === 'WRONG') s.wrong++;
      else s.pending++;
      s.idx++;
      s.attempt = null;
    }

    const sent = store.pickSentence(bundle, word, senseId, 0);
    json(res, 200, {
      applied: out.applied,
      result,
      kind: out.kind,
      grade: out.grade,
      stability: out.stability,
      difficulty: out.difficulty,
      intervalDays: out.intervalDays,
      dueAt: out.dueAt,
      sameDay: out.sameDay,
      truth: card.zh,
      translation: sent?.translation || '',
      note: sent?.note || '',
    });
  },

  async '/api/summary'(req, res) {
    const { sessionId } = await readBody(req);
    json(res, 200, { summary: summary(getSession(sessionId)), overview: store.overview(db, params) });
  },
};

function summary(s) {
  const n = s.asked;
  return {
    asked: n,
    correct: s.correct,
    wrong: s.wrong,
    pending: s.pending,
    pct: n ? Math.round((100 * s.correct) / n) : 0,
    total: s.queue.length,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[url.pathname];
  if (route) {
    try {
      await route(req, res);
    } catch (e) {
      json(res, 500, { error: String(e && e.message || e) });
    }
    return;
  }
  const hit = STATIC[url.pathname];
  if (!hit) { json(res, 404, { error: 'not found' }); return; }
  const body = fs.readFileSync(path.join(HERE, hit[0]));
  res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-store' });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  const ov = store.overview(db, params);
  console.log(`card 投影: ${n} 张（bundle ${bundle.version}）`);
  console.log(`可练 ${ov.pool} / 到期 ${ov.due} / 已掌握 ${ov.mastered} / 错题 ${ov.wrong}`);
  console.log(`user.db: ${store.USER_DB}`);
  console.log(`打开 http://127.0.0.1:${PORT}`);
});