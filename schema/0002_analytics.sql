-- ══════════════════════════════════════════════════════════════
--  0002 —— 站点访问统计（第一方，不依赖任何第三方脚本）
--
--  设计目标：回答「有多少人来过、每天多少、从哪来」「哪个作品被看得多」
--  这几个问题，同时**不做**任何用户级追踪：
--    · 不存原始 IP（存的是 IP+UA+日期 的哈希，当天内可去重，跨天无法还原到人）
--    · 不存 cookie、不存完整 UA 串
--    · 不跨站关联
--  这样既拿到数据，又不需要 cookie 同意弹窗。
--
--  ⚠ 为什么不用 Cloudflare Web Analytics 就好？
--    它是更好的方案（边缘统计、零脚本），但**要在面板里手动添加站点**才生效。
--    这个第一方表是「立刻能用」的兜底，两者可以并存不冲突。
--    详见 docs/analytics-setup.md
-- ══════════════════════════════════════════════════════════════

-- 逐日汇总。按 (day, path) 聚合，一天一行 —— 数据量可控，
-- 一年也就 365 × 页面数 行，永远不会因为访问量增长而膨胀。
CREATE TABLE IF NOT EXISTS pageviews (
  day       TEXT    NOT NULL,   -- 'YYYY-MM-DD'（按 TZ_OFFSET 偏移后的本地日期）
  path      TEXT    NOT NULL,   -- 归一化后的页面标识：'home' / 'works' / 'work' / 'bili' ...
  views     INTEGER NOT NULL DEFAULT 0,   -- PV
  visitors  INTEGER NOT NULL DEFAULT 0,   -- UV（当天按 visitor_hash 去重后的估算值）
  PRIMARY KEY (day, path)
);
CREATE INDEX IF NOT EXISTS idx_pv_day ON pageviews (day DESC);

-- 当天已出现过的访客指纹，用来算 UV。
-- 只保留当天 —— 每天清理一次，表不会无限增长。
-- hash = SHA-256(ip + ua + day + 站点 salt)，不可逆推回原始 IP。
CREATE TABLE IF NOT EXISTS pv_visitors (
  day     TEXT NOT NULL,
  hash    TEXT NOT NULL,
  PRIMARY KEY (day, hash)
);
CREATE INDEX IF NOT EXISTS idx_pvv_day ON pv_visitors (day);

-- 作品浏览计数（累计值，不按天拆 —— 目的是排「最受欢迎的作品」）
CREATE TABLE IF NOT EXISTS work_views (
  work_id TEXT    PRIMARY KEY,
  views   INTEGER NOT NULL DEFAULT 0
);
