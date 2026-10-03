// 前端逻辑：首页 → 三步答题 → 小结。
// 所有状态判断都在服务端算完再给，这里只负责显示和收集作答。

const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of ['home', 'quiz', 'done']) $(s).classList.toggle('hide', s !== id); };

let sessionId = localStorage.getItem('sid') || null;
let revealed = false;
let shownAt = 0;
let cur = null;

async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

function days(n) {
  if (n < 1) return `${Math.round(n * 24)} 小时`;
  return `${Math.round(n * 10) / 10} 天`;
}

async function refreshHome() {
  const b = await api('/api/bootstrap');
  const o = b.overview;
  $('sub').textContent =
    `词库 ${b.cards} 义项 · 可练 ${o.pool} · 本场 ${b.sessionSize} 题`;
  $('s-due').textContent = o.due;
  $('s-mastered').textContent = o.mastered;
  $('s-wrong').textContent = o.wrong;
  $('s-answered').textContent = o.answered;

  const lacking = b.cards - o.pool;
  $('pool-note').innerHTML = o.pool === 0
    ? '<span class="warn">还没有可练的题目——例句尚未生成。</span>'
    : `还有 <b>${lacking}</b> 个义项因为没有例句暂时不能练（句子生成中）。`;

  if (o.accuracy.length) {
    $('acc-box').classList.remove('hide');
    const rows = o.accuracy.map((r) =>
      `<tr><td>${r.day}</td><td>${r.n}</td><td>${r.pct}%</td></tr>`).join('');
    const total = o.accuracy.reduce((a, r) => a + r.n, 0);
    $('acc-table').innerHTML =
      `<tr><th>日期</th><th>到期卡次</th><th>正确率</th></tr>${rows}` +
      (total < 20 ? '<tr><td colspan="3" class="meta">样本不足 20，显示中</td></tr>' : '');
  } else {
    $('acc-box').classList.add('hide');
  }
  show('home');
}

$('btn-start').onclick = async () => {
  const r = await api('/api/start', { sessionId });
  sessionId = r.sessionId;
  localStorage.setItem('sid', sessionId);
  $('s-due').textContent = r.overview.due;
  await loadNext();
};

async function loadNext() {
  const r = await api('/api/next', { sessionId, sentIdx: undefined });
  if (r.done) { await finish(r); return; }
  cur = r;
  revealed = false;
  shownAt = performance.now();

  $('pos').textContent = `${r.position} / ${r.total}`;
  $('prog').style.width = `${((r.position - 1) / r.total) * 100}%`;
  $('q-word').textContent = r.word;
  const t = $('q-tier');
  t.textContent = r.tier || '';
  t.className = 'tag' + (r.tier === 'T1' ? ' tr' : '');
  $('q-pos').textContent = `${r.pos || ''} · ${r.senseId}`;
  $('q-sent').innerHTML = markUp(r.sentence);
  $('q-opts').innerHTML = '';
  $('q-fb').classList.add('hide');
  $('btn-reveal').classList.remove('hide');
  $('btn-reveal').disabled = false;
  show('quiz');
}

function markUp(s) {
  const esc = (x) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const t = esc(s.text);
  if (!s.clue) return t;
  const a = s.spanStart, b = s.spanStart + s.spanLen;
  return `${esc(t.slice(0, a))}<mark>${esc(t.slice(a, b))}</mark>${esc(t.slice(b))}`;
}

$('btn-reveal').onclick = () => {
  revealed = true;
  $('btn-reveal').classList.add('hide');
  const box = $('q-opts');
  box.innerHTML = cur.options.map((z) =>
    `<button class="opt" data-z="${escapeAttr(z)}">${escapeHtml(z)}</button>`).join('') +
    `<button class="opt" data-z="__PENDING__">我不会</button>`;
  for (const b of box.querySelectorAll('.opt')) b.onclick = () => submit(b.dataset.z);
};

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

async function submit(picked) {
  const elapsedMs = Math.round(performance.now() - shownAt);
  for (const b of $('q-opts').querySelectorAll('.opt')) {
    b.disabled = true;
    if (picked !== '__PENDING__' && b.dataset.z === picked) b.classList.add('right');
    if (picked !== '__PENDING__' && b.dataset.z === cur.sentence.gloss && picked !== cur.sentence.gloss) {
      b.classList.add('miss');
    }
  }
  const r = await api('/api/answer', {
    sessionId, attemptId: cur.attemptId, word: cur.word, senseId: cur.senseId,
    picked, elapsedMs,
  });
  if (r.error) { $('fb-tr').textContent = '提交失败：' + r.error; $('q-fb').classList.remove('hide'); return; }
  $('prog').style.width = `${(cur.position / cur.total) * 100}%`;
  $('fb-tr').innerHTML =
    (r.result === 'CORRECT' ? '✓ 对了　' : r.result === 'PENDING' ? '— 记为不会　' : '✗ 正确答案：') +
    escapeHtml(r.truth) + (r.translation ? `<br><span class="meta">${escapeHtml(r.translation)}</span>` : '');
  $('fb-nt').textContent = r.note || '';
  $('fb-srs').textContent =
    `S=${r.stability.toFixed(2)}天  D=${r.difficulty.toFixed(1)}  下次 ${days(r.intervalDays)}后` +
    `  · ${r.kind}${r.sameDay ? '（同日重复，收益减半）' : ''}`;
  $('q-fb').classList.remove('hide');
}

$('btn-next').onclick = loadNext;

async function finish(r) {
  const s = r.summary || (await api('/api/summary', { sessionId })).summary;
  $('d-asked').textContent = s.asked;
  $('d-correct').textContent = s.correct;
  $('d-wrong').textContent = s.wrong;
  $('d-pending').textContent = s.pending;
  const o = r.overview || {};
  $('d-note').innerHTML = s.asked === 0
    ? '<span class="warn">这一场没有可练的题目。</span>'
    : `本场正确率 <b>${s.pct}%</b>（${s.correct}/${s.asked}）。
       进度已存进 <code>data/user.db</code>，关掉浏览器也不会丢。`;
  show('done');
}

$('btn-again').onclick = refreshHome;

refreshHome();