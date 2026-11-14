-- ══════════════════════════════════════════════════════════════
--  0003 —— ZF语音（阶段 2 起启用；阶段 3~6 扩充频道 / 私有频道字段）
--
--  与现有业务表完全隔离：所有表统一 voice_ / invite_ / captcha_ / audit_
--  前缀或本模块专用名，不改动 messages / works / sessions / config 的任何既有列。
--  系统设置复用 config 表，键前缀 voice:，不新建设置表。
--
--  ⚠ 为什么验证码放 D1 而不是 KV：
--    KV 是最终一致的，「一次性消费」必须靠原子条件 UPDATE 实现，
--    放到 KV 里同一个验证码可能被并发请求各消费一次。
--    同理邀请码的 use_count 上限也必须用条件 UPDATE 兜住并发。
--
--  架构约束（2026-11-14 用户追加）：
--    生产后端**只有 Cloudflare Worker**（+ DO / D1 / KV / Realtime SFU）。
--    用户的电脑只作为浏览器客户端「添加私有频道」，不跑任何常驻服务。
--    private 频道与 public 频道一样由 Worker 承载，媒体走 Cloudflare SFU；
--    self_hosted_servers 仅保存「可选高级模式」配置，默认不使用。
-- ══════════════════════════════════════════════════════════════

-- 注册用户。display_name 允许重复，输出时一律转义（防 XSS）。
CREATE TABLE IF NOT EXISTS voice_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,             -- 登录名：^[a-z0-9_]{3,20}$
  display_name  TEXT NOT NULL,
  avatar_ref    TEXT,                            -- KV key；NULL = 用默认头像
  avatar_color  TEXT NOT NULL,                   -- 用户名哈希决定的稳定底色（#rrggbb）
  password_rec  TEXT NOT NULL,                   -- JSON：{"salt","hash","iter"}
  role          TEXT NOT NULL DEFAULT 'user',    -- user | admin
  status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled | banned
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vu_status ON voice_users(status);
CREATE INDEX IF NOT EXISTS idx_vu_created ON voice_users(created_at DESC);

-- 会话。Cookie 里只放随机 token，库里只放 token 的 SHA-256，
-- 即使数据库泄露也无法直接拿去冒充登录。
CREATE TABLE IF NOT EXISTS voice_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  exp        INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vs_user ON voice_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_vs_exp ON voice_sessions(exp);

-- 邀请码。明文只在创建时返回一次，库里只存 SHA-256 与展示掩码。
-- 软删除：删除后不可再用于注册，已注册用户不受影响。
CREATE TABLE IF NOT EXISTS invite_codes (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,
  code_mask   TEXT NOT NULL,        -- 例：'A7K2••••9Q'，供后台辨认
  note        TEXT,
  expires_at  INTEGER,              -- NULL = 永不过期
  max_uses    INTEGER,              -- NULL = 不限次数（默认）
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ic_deleted ON invite_codes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_ic_created ON invite_codes(created_at DESC);

CREATE TABLE IF NOT EXISTS invite_code_uses (
  id       TEXT PRIMARY KEY,
  code_id  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  used_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_icu_code ON invite_code_uses(code_id, used_at DESC);

-- 验证码挑战。answer_hash = SHA-256(id|答案|密钥)，明文答案绝不落库。
-- 无论答对答错，都通过原子条件 UPDATE 置 consumed=1，实现真正的一次性。
CREATE TABLE IF NOT EXISTS captcha_challenges (
  id          TEXT PRIMARY KEY,
  answer_hash TEXT NOT NULL,
  exp         INTEGER NOT NULL,
  consumed    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captcha_exp ON captcha_challenges(exp);

-- 频道。public = 所有注册用户可见；private = 只有自己 / 受邀成员可见。
-- 注意：private 只是「频道可见性与加入口令」，媒体后端仍然是 Cloudflare Worker + SFU。
CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  descr       TEXT,
  icon        TEXT,
  backend     TEXT NOT NULL DEFAULT 'cloudflare',  -- cloudflare | self_hosted（可选高级模式）
  server_id   TEXT,
  visibility  TEXT NOT NULL DEFAULT 'public',      -- public | private
  password_hash TEXT,                             -- 私有频道可选加入口令（SHA-256 + 盐）
  allowed_users TEXT,                             -- JSON 数组：可见/可加入的用户 id
  owner_id    TEXT,                               -- 私有频道创建者
  ord         INTEGER NOT NULL DEFAULT 0,
  join_scope  TEXT NOT NULL DEFAULT 'all',         -- all | roles
  join_roles  TEXT,                                -- JSON 数组
  max_users   INTEGER NOT NULL DEFAULT 20,
  revision    INTEGER NOT NULL DEFAULT 1,          -- 设置变更时 +1，供实时下发
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ch_ord ON channels(ord, created_at);
CREATE INDEX IF NOT EXISTS idx_ch_vis ON channels(visibility);

-- 音质 / 屏幕共享上限。每次后台修改都把 channels.revision + 1，
-- Worker 通过 Durable Object 把新设置实时推给在线客户端。
CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id  TEXT PRIMARY KEY,
  audio_json  TEXT NOT NULL,   -- {preset,bitrateKbps,sampleRate,channels,dtx,fec,frameMs}
  screen_json TEXT NOT NULL,   -- {enabled,maxWidth,maxHeight,maxFps,maxBitrateKbps,maxSharers}
  updated_at  INTEGER NOT NULL
);

-- Cloudflare Realtime SFU 会话归属。tracks/new / renegotiate / close
-- 都必须先查这张表，防止有人拿别人的 sessionId 越权关闭轨道。
CREATE TABLE IF NOT EXISTS voice_sfu_sessions (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'publish',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vss_user ON voice_sfu_sessions(user_id, channel_id);

-- 可选高级模式：自建 SFU（LiveKit）连接配置。密钥名只存引用，真实密钥放
-- Worker secret，绝不下发浏览器。用户电脑默认不需要跑任何服务。
CREATE TABLE IF NOT EXISTS self_hosted_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL DEFAULT 7880,
  tls          INTEGER NOT NULL DEFAULT 1,
  screen_host  TEXT,
  secret_ref   TEXT NOT NULL,   -- Worker secret 名，密钥绝不下发前端
  status       TEXT NOT NULL DEFAULT 'unknown',
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);

-- 关键操作审计（登录 / 注册 / 邀请码 / 频道配置 / 踢人 / 禁言）。
CREATE TABLE IF NOT EXISTS audit_logs (
  id     TEXT PRIMARY KEY,
  ts     INTEGER NOT NULL,
  actor  TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,            -- JSON
  ip     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);

-- 预置 Cloudflare 语音频道（全部由 Worker 承载，无需用户电脑）。
INSERT OR IGNORE INTO channels
  (id, name, descr, backend, ord, join_scope, max_users, revision, created_at, updated_at)
VALUES
  ('cf-lobby', '开黑频道1', 'ZF语音默认频道 · 和朋友开黑聊天', 'cloudflare', 0, 'all', 20, 1, 0, 0),
  ('cf-2',     '开黑频道2', '第二语音房 · 人多时分流',          'cloudflare', 1, 'all', 20, 1, 0, 0),
  ('cf-3',     '开黑频道3', '挂机 / 听歌房',                    'cloudflare', 2, 'all', 20, 1, 0, 0);

-- 默认音质（标准）与屏幕共享上限。后台修改后会实时覆盖。
INSERT OR IGNORE INTO channel_settings (channel_id, audio_json, screen_json, updated_at)
VALUES
  ('cf-lobby', '{"preset":"standard","bitrateKbps":48,"sampleRate":48000,"channels":1,"dtx":true,"fec":true,"frameMs":20}',
   '{"enabled":true,"maxWidth":1920,"maxHeight":1080,"maxFps":30,"maxBitrateKbps":4000,"maxSharers":2}', 0),
  ('cf-2', '{"preset":"standard","bitrateKbps":48,"sampleRate":48000,"channels":1,"dtx":true,"fec":true,"frameMs":20}',
   '{"enabled":true,"maxWidth":1920,"maxHeight":1080,"maxFps":30,"maxBitrateKbps":4000,"maxSharers":2}', 0),
  ('cf-3', '{"preset":"standard","bitrateKbps":48,"sampleRate":48000,"channels":1,"dtx":true,"fec":true,"frameMs":20}',
   '{"enabled":true,"maxWidth":1920,"maxHeight":1080,"maxFps":30,"maxBitrateKbps":4000,"maxSharers":2}', 0);

-- 系统设置放 config 表（k/v）。缺省值由 Worker 的 DEFAULT_SETTINGS 兜底，
-- 所以这里不预插记录，管理员第一次改设置时才生成。
--   voice:settings = {"registrationOpen":true,"captchaMode":"image",
--                     "allowUserSelfHosted":false,"allowUserPrivateChannels":true}
