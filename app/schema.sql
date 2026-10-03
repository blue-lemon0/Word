-- 运行时进度库 user.db 的唯一 schema 真相源。
-- Node（app/db.mjs，node:sqlite）与将来的 Android（原生 SQLite）跑同一份 SQL。
--
-- 设计边界（见 docs/decisions/D17-存储分层.md）：
--   内容（7884 义项 + 句子）**不入库**，它是 assets/bundle/cards.json，
--   一次性读进内存。本库只存「索引投影」+「用户进度」。
--
-- 三张表的分工：
--   card        bundle 的投影，可随时 DELETE+INSERT 重建，不承载任何真相
--   card_state  用户进度，唯一真相源
--   review_log  作答流水，只增不改，所有统计从它算
--   meta        schema 版本与 bundle 版本

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 句子问题标记（背单词时随手标，事后统一改）───────────
-- 生成不过度审：句子批量出，遇到问题随手标一句 + 备注，事后按这张表改。
-- 标了就不再出这句（02 文档的 status='bad'），不拿已知有问题的句子考用户。
-- sentence 存原文而不是外键 —— 内容在 bundle 里，DB 不持有句子表。
CREATE TABLE IF NOT EXISTS sentence_flag (
  id        INTEGER PRIMARY KEY,
  word      TEXT    NOT NULL,
  sense_id  TEXT    NOT NULL,
  sentence  TEXT    NOT NULL,     -- 句子原文，天然指纹
  note      TEXT,                 -- 备注，可空
  ts        INTEGER NOT NULL,
  UNIQUE(word, sense_id, sentence)
);
CREATE INDEX IF NOT EXISTS ix_flag_ts ON sentence_flag(ts DESC);

-- ── 前端 UI 状态 ───────────────────────────────────
-- tools/index.html 原来把整套 state（queue/pos/stats/wrong/mastered/rowIdx）
-- 塞进 localStorage。localStorage 换浏览器、清缓存、重装就没了，
-- 而且没有事务。这里把它作为**备份与跨设备副本**存一份：
-- 前端仍以 localStorage 为准（离线可用、秒开），
-- 每次 saveState() 顺手推一份上来，启动时若本地为空就从这里恢复。
-- 真正的记忆模型不在这里 —— S/D/due_at 在 card_state，作答流水在 review_log。
CREATE TABLE IF NOT EXISTS ui_state (
  key   TEXT PRIMARY KEY,     -- 固定 'main'
  value TEXT NOT NULL,        -- state 的 JSON
  ts    INTEGER NOT NULL
);

-- ── bundle 投影 ─────────────────────────────────────
-- 为什么已有 bundle 还要存一份：到期查询与排布权重要 JOIN tier / is_trap，
-- 没有它就只能把 7884 行拉到内存里做。存的是投影，不是内容，
-- bundle 一升级就整表重建（app/db.mjs 的 rebuildCards）。
CREATE TABLE IF NOT EXISTS card (
  word      TEXT    NOT NULL,
  sense_id  TEXT    NOT NULL,
  tier      TEXT    NOT NULL DEFAULT '',
  is_trap   INTEGER NOT NULL DEFAULT 0,
  n_sent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (word, sense_id)
);
CREATE INDEX IF NOT EXISTS ix_card_pool ON card(n_sent, tier);

-- ── 用户进度 ───────────────────────────────────────
-- stability / difficulty 见 docs/design/03-记忆曲线与复习.md
-- 未练过的卡在 v_pool 里用 COALESCE 兜底，不预先插 7884 行空状态。
--
-- due_at 必须单列存，不要在视图里现算 last_review + stability*86400：
--   引擎排期用的是**答对前**的 S（间隔 = S_before × ef），而 stability 存的是
--   **答对后**的 S（= S_before × (1+ef)）。两者差一个 (1+ef) 倍，
--   现算会让实际到期时间比 App 告诉用户的时间晚将近一倍。
CREATE TABLE IF NOT EXISTS card_state (
  word        TEXT    NOT NULL,
  sense_id    TEXT    NOT NULL,
  stability   REAL    NOT NULL DEFAULT 0,
  difficulty  REAL    NOT NULL DEFAULT 8.0,
  last_review INTEGER,
  due_at      INTEGER NOT NULL DEFAULT 0,   -- unix 秒；0 = 未排期 = 立即到期
  reps        INTEGER NOT NULL DEFAULT 0,
  wrong_n     INTEGER NOT NULL DEFAULT 0,
  pending_n   INTEGER NOT NULL DEFAULT 0,
  mastered    INTEGER NOT NULL DEFAULT 0,
  rusty       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (word, sense_id)
);
-- 到期判定扫这条：mastered=0 AND due_at <= now
CREATE INDEX IF NOT EXISTS ix_state_due ON card_state(mastered, due_at);

-- ── 作答流水 ───────────────────────────────────────
-- 幂等靠 attempt_id：/api/next 每出一次题就发一个 attempt_id，
-- 客户端作答时原样带回。同一次出题的重复提交（网络重试、连点两下）撞同一个
-- attempt_id 被静默丢弃，不会重复累加 card_state。
--
-- 不能用 UNIQUE(session_id, word, sense_id) —— 同一场里允许同一张卡重复出现
--（03 §4.1 的 WRONG 后 2 小时再现就会落在同一场），那样会把合法重复判成重放。
CREATE TABLE IF NOT EXISTS review_log (
  session_id     TEXT    NOT NULL,
  idx            INTEGER NOT NULL,
  attempt_id     TEXT    NOT NULL,     -- 出题时服务端下发，作答时带回
  word           TEXT    NOT NULL,
  sense_id       TEXT    NOT NULL,
  sentence       TEXT,                 -- 当时出的那句原文；历史列表要显示它
  result         TEXT    NOT NULL,     -- CORRECT / WRONG / PENDING
  grade          INTEGER NOT NULL,     -- 0 / 2 / 4 / 5
  elapsed_ms     INTEGER,
  is_due         INTEGER NOT NULL DEFAULT 1,   -- 提前复习不计入正确率
  stability_after REAL,
  ts             INTEGER NOT NULL,
  PRIMARY KEY (session_id, idx)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_log_attempt ON review_log(session_id, attempt_id);
CREATE INDEX IF NOT EXISTS ix_log_day   ON review_log(ts);
CREATE INDEX IF NOT EXISTS ix_log_sense ON review_log(word, sense_id, ts DESC);

-- ── 视图：把不变量钉在 SQL 层 ────────────────────────

-- 可练池：至少 1 道 active 句，且卡本身 active。
-- 没练过的卡也要出现，所以对 card_state 用 LEFT JOIN + COALESCE 兜底。
CREATE VIEW IF NOT EXISTS v_pool AS
SELECT c.word, c.sense_id, c.tier, c.is_trap, c.n_sent,
       COALESCE(s.stability, 0)  AS stability,
       COALESCE(s.difficulty, 8.0) AS difficulty,
       COALESCE(s.last_review, 0) AS last_review,
       COALESCE(s.due_at, 0)     AS due_at,
       COALESCE(s.reps, 0)       AS reps,
       COALESCE(s.wrong_n, 0)    AS wrong_n,
       COALESCE(s.pending_n, 0)  AS pending_n,
       COALESCE(s.mastered, 0)   AS mastered,
       COALESCE(s.rusty, 0)      AS rusty
FROM card c
LEFT JOIN card_state s ON s.word = c.word AND s.sense_id = c.sense_id
WHERE c.n_sent > 0;

-- 到期：从没练过（due_at=0），或已过排期时间。
CREATE VIEW IF NOT EXISTS v_due AS
SELECT * FROM v_pool
WHERE mastered = 0
  AND due_at <= CAST(strftime('%s','now') AS INTEGER);

-- 错题板：不额外维护一张错题表（D14 原则）。
-- 移出条件 = 最近两次有效作答都是 CORRECT（连对 2 次）。
-- 注意判据要同时看第 1、第 2 条：只查第 2 条会把「先对后错」误判成已连对 2 次。
CREATE VIEW IF NOT EXISTS v_wrong AS
SELECT p.*,
       (SELECT COUNT(*) FROM review_log l
         WHERE l.word = p.word AND l.sense_id = p.sense_id
           AND l.result = 'WRONG') AS wrong_total
FROM v_pool p
WHERE p.wrong_n > 0 AND p.mastered = 0
  AND NOT (
        (SELECT l.result FROM review_log l
          WHERE l.word = p.word AND l.sense_id = p.sense_id
          ORDER BY l.ts DESC, l.rowid DESC LIMIT 1) = 'CORRECT'
    AND (SELECT l.result FROM review_log l
          WHERE l.word = p.word AND l.sense_id = p.sense_id
          ORDER BY l.ts DESC, l.rowid DESC LIMIT 1 OFFSET 1) = 'CORRECT')
ORDER BY wrong_total DESC, p.wrong_n DESC;

-- 诚实正确率：只统计到期卡次的 CORRECT/WRONG，PENDING 进分母不进分子。
-- 样本 < MIN_SAMPLES 显示「积累中」，避免拿 3 次作答吹牛。
CREATE VIEW IF NOT EXISTS v_accuracy AS
SELECT date(ts, 'unixepoch', 'localtime') AS day,
       COUNT(*) AS n,
       SUM(result = 'CORRECT') AS right_n,
       ROUND(100.0 * SUM(result = 'CORRECT') / COUNT(*), 1) AS pct
FROM review_log
WHERE is_due = 1 AND result IN ('CORRECT','WRONG','PENDING')
GROUP BY day ORDER BY day DESC;