# SQLite 数据模型

> **历史文档（2026-10-20 起冻结）**：本文是旧服务端那一线的"目标形态"设计，
> 实际落地的是 4 表子集，SQL 真相源在 [`app/schema.sql`](../../app/schema.sql)。
> 取舍理由见决策 D17（已随产线删除，git 历史可查）。
> 应用当前的数据层在 `app/web/`（Dexie/IndexedDB，见 DESIGN-词库系统v2.md），
> 本文档保留作为 SQLite/Room 移植时的参照。
> 关联：`03-记忆曲线与复习.md` §4（01/02 已删，git 历史可查）。
> 依据：真实数据探针（旧库 3641 义项 / 16612 句 → DB 4.37MB，建库 1.20s，
> 五条热查询均 < 2.2ms，外键孤儿 0）。新库句子生成后需重测。

---

## 1. 为什么放弃 localStorage

存储估算（106 字节/句实测）：

| 每义项句数 | 义项数 | 句总数 | 体积 | localStorage 上限 5MB |
| --- | --- | --- | --- | --- |
| 8 | 7884 | 63072 | 6.7 MB | **超** |
| 15 | 7884 | 118260 | 12.5 MB | **超 2.5 倍** |
| 30 | 7884 | 236520 | 25 MB | **超 5 倍** |

而 localStorage 是**同步阻塞**的，25MB 的读写在主线程会直接卡住 UI。
所以生产环境必须 SQLite（异步、有索引、支持事务）。

---

## 2. 表结构

> **D17 落地版（`app/schema.sql`，4 表 + 3 视图）**

> ```sql
> meta(key, value)                        -- schema 版本 / bundle 版本
> card(word, sense_id, tier, is_trap, n_sent)   -- bundle 投影，可整表重建
> card_state(word, sense_id, stability, difficulty, last_review, due_at,
>            reps, wrong_n, pending_n, mastered, rusty)   -- 用户进度，唯一真相源
> review_log(session_id, idx, attempt_id, word, sense_id,
>            result, grade, elapsed_ms, is_due, stability_after, ts)
> ```
>
> 相比下面的完整设计去掉了 `sense` / `sentence`（内容在 `build/bundle/cards.json`，
> 一次性读进内存）、`new_word` / `user_flag` / `setting`（对应功能未开工）。
> 三处与本文原文不同：`srs.due_at` 单列、`review_log.attempt_id` 幂等、
> `v_wrong` 同时查最近两条（理由见 D17，git 历史可查）。

<details>
<summary>完整设计（7 表 4 视图，02 句子轮换开工时启用）</summary>

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;      -- 写入不阻塞读取
PRAGMA synchronous = NORMAL;   -- 个人自用，不需 FULL

-- ── 义项（静态，随 bundle 导入）────────────────────
CREATE TABLE sense (
  id           INTEGER PRIMARY KEY,   -- 自增
  word         TEXT NOT NULL,
  sense_id     TEXT NOT NULL,         -- s1/s2/...（bundle 内稳定）
  pos          TEXT,
  gloss_zh     TEXT NOT NULL,
  gloss_en     TEXT,                  -- ECDICT definition 子集，多数为空
  is_trap      INTEGER NOT NULL DEFAULT 0,
  tier         TEXT,                  -- T1/T2/T3/T4
  status       TEXT NOT NULL DEFAULT 'active',  -- active/archived
  UNIQUE(word, sense_id)
);
CREATE INDEX ix_sense_word  ON sense(word);
CREATE INDEX ix_sense_trap  ON sense(is_trap, status);

-- ── 句子（动态，可增可退役）──────────────────────
CREATE TABLE sentence (
  id            INTEGER PRIMARY KEY,
  sense_pk      INTEGER NOT NULL REFERENCES sense(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  clue          TEXT,
  span_start    INTEGER,
  span_len      INTEGER,
  translation   TEXT,
  note          TEXT,
  fingerprint   TEXT,                  -- 全库去重
  status        TEXT NOT NULL DEFAULT 'pending', -- pending/active/retired/bad/rejected
  source        TEXT NOT NULL DEFAULT 'GENERATED',  -- GENERATED/LIVE/MANUAL
  difficulty    INTEGER DEFAULT 2,
  seen_count    INTEGER NOT NULL DEFAULT 0,
  streak_ok     INTEGER NOT NULL DEFAULT 0,   -- 连续答对次数
  last_shown_at INTEGER,              -- unix 秒
  prompt_ver    TEXT,
  judge_ver     TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX ix_sent_sense  ON sentence(sense_pk, status);
CREATE INDEX ix_sent_status ON sentence(status, last_shown_at);
CREATE UNIQUE INDEX ux_sent_fp ON sentence(fingerprint) WHERE status='active';

-- ── 义项级 SRS 状态（挂在义项，不挂句子）──────────
CREATE TABLE srs (
  sense_pk     INTEGER PRIMARY KEY REFERENCES sense(id) ON DELETE CASCADE,
  stability    REAL NOT NULL DEFAULT 0.6,    -- S，天
  difficulty   REAL NOT NULL DEFAULT 8.0,    -- D，1-10
  last_review  INTEGER,
  reps         INTEGER NOT NULL DEFAULT 0,
  wrong_n      INTEGER NOT NULL DEFAULT 0,
  pending_n    INTEGER NOT NULL DEFAULT 0,
  mastered     INTEGER NOT NULL DEFAULT 0,
  rusty        INTEGER NOT NULL DEFAULT 0,
  tier_applied TEXT                     -- 义项类型，决定 S0/D0
);
CREATE INDEX ix_srs_due ON srs(mastered, stability);

-- ── 作答流水（只增不改，是所有统计的真相源）──────
CREATE TABLE session_log (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL,             -- 作答唯一键的一部分
  sense_pk    INTEGER NOT NULL,
  sentence_pk INTEGER,
  result      TEXT NOT NULL,                -- CORRECT/WRONG/PENDING/INVALID
  elapsed_ms  INTEGER,
  is_due      INTEGER NOT NULL DEFAULT 1,  -- 是否到期卡次（诚实曲线用）
  ts          INTEGER NOT NULL,
  UNIQUE(session_id, idx)                  -- 幂等：重复提交只生效一次
);
CREATE INDEX ix_log_sense ON session_log(sense_pk, ts DESC);
CREATE INDEX ix_log_sent  ON session_log(sentence_pk, ts DESC);

-- ── 生词库 ─────────────────────────────────────
CREATE TABLE new_word (
  word      TEXT PRIMARY KEY,
  note      TEXT,
  added_at  INTEGER NOT NULL
);

-- ── 用户纠错标记（对应 user_flags.jsonl）───────
CREATE TABLE user_flag (
  id          INTEGER PRIMARY KEY,
  sentence_pk INTEGER NOT NULL,
  reason      TEXT NOT NULL,   -- TRANS_WRONG/SENSE_MISMATCH/DISTRACTOR/HARD_OR_EASY/OTHER
  detail      TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX ix_flag_sent ON user_flag(sentence_pk);

-- ── 设置 ───────────────────────────────────────
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

</details>

---

## 3. 视图（不变量在 SQL 层保证）

```sql
-- 有题可练的义项池：排布只用这个
CREATE VIEW v_pool AS
SELECT s.id, s.word, s.sense_id, s.pos, s.gloss_zh, s.is_trap, s.tier,
       COUNT(sc.id) AS active_n,
       sr.stability, sr.difficulty, sr.mastered, sr.rusty,
       sr.wrong_n, sr.pending_n, sr.last_review, sr.reps
FROM sense s
JOIN srs      sr ON sr.sense_pk = s.id
LEFT JOIN sentence sc ON sc.sense_pk = s.id AND sc.status = 'active'
WHERE s.status = 'active'
GROUP BY s.id
HAVING active_n > 0;          -- 不变量1：至少有 1 道可练的题

-- 到期卡：真实天数判定
CREATE VIEW v_due AS
SELECT * FROM v_pool
WHERE mastered = 0
  AND (last_review IS NULL
       OR last_review + CAST(stability * 86400 AS INTEGER) <= strftime('%s','now'));

-- 错题板：连续 2 次答对即移出，不存第二份状态
CREATE VIEW v_wrong AS
SELECT p.*,
       (SELECT COUNT(*) FROM session_log l
         WHERE l.sense_pk = p.id AND l.result='WRONG') AS wrong_total
FROM v_pool p
WHERE p.wrong_n > 0 AND p.mastered = 0
  AND (SELECT l.result FROM session_log l
        WHERE l.sense_pk = p.id AND l.result <> 'INVALID'
        ORDER BY l.ts DESC LIMIT 2 OFFSET 1) = 'CORRECT'   -- 非连续2对则保留
ORDER BY wrong_total DESC, wrong_n DESC;

-- 诚实正确率：只统计到期卡次，排除提前复习
CREATE VIEW v_accuracy AS
SELECT date(ts,'unixepoch','localtime') AS day,
       COUNT(*) AS n,
       SUM(result='CORRECT') AS right_n,
       ROUND(100.0*SUM(result='CORRECT')/COUNT(*),1) AS pct
FROM session_log
WHERE is_due = 1 AND result IN ('CORRECT','WRONG','PENDING')
GROUP BY day ORDER BY day DESC;
```

> `v_wrong` 的"最近第 2 次也是 CORRECT 则移出"用相关子查询表达，
> **不额外维护一张错题表**（D14 原则）。

---

## 4. bundle（只读静态资产）vs 用户库（可写）

| | bundle | user.db |
| --- | --- | --- |
| 内容 | sense + 初始 sentence + SRS 初值 | 全部作答与状态 |
| 来源 | 开发机打包，APK 内 | 设备本地 |
| 更新 | 换版本时整体替换 | 永久累积，**不随 bundle 重置** |
| 写入 | 只读 | 频繁 |

**升级时的合并**（不是覆盖）：

```sql
-- 新 bundle 的 sense 表 → 用 INSERT OR IGNORE 补进 user.db
INSERT OR IGNORE INTO sense (word, sense_id, pos, gloss_zh, gloss_en, is_trap, tier)
SELECT word, sense_id, pos, gloss_zh, gloss_en, is_trap, tier FROM bundle_sense;

-- 新增义项补 SRS 初值
INSERT OR IGNORE INTO srs (sense_pk, tier_applied)
SELECT id, tier FROM sense WHERE id NOT IN (SELECT sense_pk FROM srs);

-- 句子：按 (sense_pk, text) 幂等插入
INSERT OR IGNORE INTO sentence (sense_pk, text, clue, ...) SELECT ... FROM bundle_sentence;
```

**`mastered` / `wrong_n` / 历史 `session_log` 一律不因升级而丢失**——
前提是 `senseId` 稳定（同词库增量升级）。

> **换源例外（D16，git 历史可查）**：从考纲词频表换成 ECDICT 属于换库而非升级，
> `sense_pk` 全变，此时**不合并、不继承**，直接重建 `user.db`。

---

## 5. 关键查询

**会话排布**（每场开始一次，< 5ms）：
```sql
SELECT p.* FROM v_due p
ORDER BY (0.5*wrong_n*1.0
          + 0.3*is_trap
          + 0.2*(1.0 - MIN(1.0, stability/180.0))) DESC
LIMIT :n;
```

**取一条题**（< 2ms）：
```sql
SELECT * FROM sentence
WHERE sense_pk = :pk AND status='active'
ORDER BY (seen_count=0) DESC, COALESCE(last_shown_at,0) ASC
LIMIT 1;
```

**会话结果落库**（单事务，幂等）：
```sql
BEGIN;
INSERT OR IGNORE INTO session_log (session_id, idx, ...) VALUES (...);
-- 仅当真的插入成功（changes()=1）才更新 srs 与 sentence
-- 否则重复提交被静默忽略（UNIQUE 约束保证）
UPDATE sentence SET seen_count = seen_count + :delta,
                    streak_ok  = :new_streak,
                    last_shown_at = :now
WHERE id = :sid;
UPDATE srs SET stability = :S, difficulty = :D, last_review = :now, reps = reps + 1
WHERE sense_pk = :pk;
COMMIT;
```

---

## 6. 迁移脚本

| 版本 | 变更 |
| --- | --- |
| v1 | 上述 7 表 + 4 视图 |

`PRAGMA user_version` 记录版本，升级走 `schema_migrations` 表。
个人自用，**不做降级迁移**（备份导出即保险）。

> **换库 ≠ 升级。** 换源（D16）时 `sense_pk` 全变、用户进度无法继承，
> 此时直接重建 `user.db`（或改用新的文件名并存），不写迁移脚本。
> schema 版本迁移只针对"同词库加了张表"这类变更。

---

## 7. 性能实测

在旧库（3641 义项 / 16612 句）上实测：

```
建库          1.20 s
DB 体积       4.37 MB
会话排布      1.8 ms
取一句        0.3 ms
落库一次作答  2.2 ms
错题板        1.1 ms
外键孤儿      0
```

按新库 7884 义项 / 39420 句线性外推：DB ≈ 10.4 MB，各查询仍 < 5 ms。
**远低于"启动到可练 < 2s"的红线**（规格 §11）。

> 该实测用的是已删除的旧数据（义项快照在 git 历史
> `bfda5d7` 之前可查）。新库句子生成后应重跑一次确认。
