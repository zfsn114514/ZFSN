-- ══════════════════════════════════════════════════════════════
--  私密作品文件夹（PIN 保护）
--
--  works.private = 1 的作品不会出现在公开的 GET /api/works 里，
--  必须先在 /api/private/unlock 用 4 位 PIN 换一张短期票（token），
--  再带 x-private-token 头访问 /api/private/works 才能看到。
--
--  PIN 本身不落明文：复用 config 表的 password 记录格式
--  （PBKDF2-HMAC-SHA512，salt + hash + iter），key 为 private_pin。
--  首次调用解锁接口时若该记录不存在，会用默认 PIN「1145」自动初始化，
--  之后可在管理后台改。改 PIN 会同时换掉 private_pin.ver，
--  让所有已签发的票立即失效。
--
--  ⚠ 4 位 PIN 只有 10000 种组合，离线爆破几乎必然成功，
--    所以真正的防线不是哈希强度，而是**在线尝试限流**
--    （解锁接口按 IP 限 6 次 / 15 分钟）。别把哈希当成安全保证。
-- ══════════════════════════════════════════════════════════════

ALTER TABLE works ADD COLUMN private INTEGER NOT NULL DEFAULT 0;

-- 私密作品要按 ord 排序单独取，公开列表则走 private = 0 的过滤
CREATE INDEX IF NOT EXISTS idx_works_private ON works (private, ord, ts);
