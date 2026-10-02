-- ══════════════════════════════════════════════════════════════
--  ZFSN 站点 —— D1 初始建表
--  对应迁移前的 data/*.json：
--    messages.json          → messages
--    works.json             → works
--    work_interactions.json → likes / comments
--    config.json（密码哈希）→ config
--    tokens.json（会话）    → sessions
--    Node 进程内存里的限流  → rate
--
--  字段命名避开了 SQL 保留字：desc → descr，order → ord。
--  保留字做列名在 D1 里要么报错要么得加引号，白白给自己挖坑。
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS messages (
  id       TEXT    PRIMARY KEY,
  name     TEXT    NOT NULL,
  text     TEXT    NOT NULL,
  ts       INTEGER NOT NULL,
  time     TEXT    NOT NULL,
  ip       TEXT,
  geo      TEXT,                       -- JSON 字符串
  ua       TEXT,
  images   TEXT,                       -- JSON 数组：["/api/media/messages/xx/0.png"]
  voices   TEXT,                       -- JSON 数组：[{url, duration}]
  deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts DESC);

CREATE TABLE IF NOT EXISTS works (
  id         TEXT    PRIMARY KEY,
  title      TEXT    NOT NULL,
  descr      TEXT,
  link       TEXT,
  cover      TEXT,
  tag        TEXT,
  images     TEXT,                     -- JSON 数组
  video      TEXT,                     -- 单个路径，空串表示无
  files      TEXT,                     -- JSON 数组：[{name, path, size, sizeText}]
  ord        INTEGER NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL,
  time       TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_works_ord ON works (ord, ts DESC);

-- 点赞：同一 IP 对同一作品只能点一次，所以拿 (work_id, ip) 做主键
CREATE TABLE IF NOT EXISTS likes (
  work_id TEXT    NOT NULL,
  ip      TEXT    NOT NULL,
  geo     TEXT,
  ua      TEXT,
  ts      INTEGER NOT NULL,
  time    TEXT,
  PRIMARY KEY (work_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_likes_work ON likes (work_id);

CREATE TABLE IF NOT EXISTS comments (
  id      TEXT    PRIMARY KEY,
  work_id TEXT    NOT NULL,
  name    TEXT,
  text    TEXT,
  ip      TEXT,
  geo     TEXT,
  ua      TEXT,
  ts      INTEGER NOT NULL,
  time    TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_work ON comments (work_id, ts);

-- 管理员会话。登出 = 删行；改密 = 清空整表（强制所有设备下线）
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT    PRIMARY KEY,
  ip    TEXT,
  ua    TEXT,
  exp   INTEGER NOT NULL,
  at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (exp);

-- 键值配置，目前只放 password（PBKDF2 的 salt + hash，JSON 字符串）
CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 限流计数。Workers 没有跨请求共享内存，原先 Node 内存里的 Map 得落库。
CREATE TABLE IF NOT EXISTS rate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  k  TEXT    NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_k_ts ON rate (k, ts);
