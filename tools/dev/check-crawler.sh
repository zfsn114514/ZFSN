#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  站长平台 403 诊断脚本
#  用法：bash tools/dev/check-crawler.sh
#
#  背景：Search Console 和 Bing Webmaster 都报 403，但服务器侧
#  实测（curl 带 Googlebot/bingbot UA）全部 200、返回完整 HTML。
#  说明 403 来自 Cloudflare 边缘的某个开关，不是 Worker 代码。
#  这份脚本用来把「服务器侧」和「边缘侧」的责任分清楚。
# ══════════════════════════════════════════════════════════════

SITE="https://www.zfsnnb.dpdns.org"

GB_MOBILE="Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
GB_DESKTOP="Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.0.0 Safari/537.36"
BING="Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"

code() { curl -sL -o /dev/null -w "%{http_code}" --max-time 45 -A "$2" "$1" 2>/dev/null; }
bytes() { curl -sL -o /dev/null -w "%{size_download}" --max-time 45 -A "$2" "$1" 2>/dev/null; }

# 本机有代理，偶发握手失败会返回 000。重试 3 次再判定，
# 否则会把代理抖动误报成站点故障。
code() {
  local u="$1" ua="$2" r=""
  for i in 1 2 3; do
    r=$(curl -sL -o /dev/null -w "%{http_code}" --max-time 45 -A "$ua" "$u" 2>/dev/null)
    [ "$r" != "000" ] && { echo "$r"; return; }
    sleep 2
  done
  echo "$r"
}
bytes() {
  local u="$1" ua="$2" r=""
  for i in 1 2 3; do
    r=$(curl -sL -o /dev/null -w "%{size_download}" --max-time 45 -A "$ua" "$u" 2>/dev/null)
    [ "$r" != "0" ] && { echo "$r"; return; }
    sleep 2
  done
  echo "$r"
}

echo "═══════════════════════════════════════════════════════"
echo " 服务器侧实测（绕过站长平台，直接从公网请求）"
echo "═══════════════════════════════════════════════════════"
printf "%-34s %-8s %-8s %-10s %s\n" "路径" "普通" "Google" "Bing" "字节数"
echo "───────────────────────────────────────────────────────"
for p in "/" "/index.html" "/robots.txt" "/sitemap.xml" "/pvz/pvz-portable.html"; do
  u="$SITE$p"
  n=$(code "$u" "Mozilla/5.0")
  g=$(code "$u" "$GB_DESKTOP")
  b=$(code "$u" "$BING")
  s=$(bytes "$u" "$GB_DESKTOP")
  printf "%-34s %-8s %-8s %-10s %s\n" "$p" "$n" "$g" "$b" "$s"
done

echo
echo "═══════════════════════════════════════════════════════"
echo " 关键判定"
echo "═══════════════════════════════════════════════════════"
g=$(code "$SITE/" "$GB_DESKTOP")
if [ "$g" = "200" ]; then
  echo " ✅ 服务器对 Googlebot 返回 200 —— 问题不在你的代码/服务器。"
  echo "    403 来自 Cloudflare 边缘，按下面清单逐项排查。"
else
  echo " ❌ 服务器侧确实返回 $g —— 这才是真正要修的。"
fi

echo
echo "═══════════════════════════════════════════════════════"
echo " Cloudflare 面板待检查项（我无权限，需你手动确认）"
echo "═══════════════════════════════════════════════════════"
cat <<'EOF'
 1. 安全性 → 设置 → 「Bot Fight Mode」
    必须关闭。（这是之前 403 的已知根因，确认它没被重新打开）

 2. 安全性 → 设置 → 「安全级别」
    调到「中」或「低」。高会拦掉部分爬虫。

 3. 安全性 → WAF → 自定义规则
    看有没有针对 UA / IP / geo 的 Block 规则。
    注意：只按 IP 拦没用（Googlebot IP 段常变），
    要拦必须按 UA + 验证后的 bot 身份。

 4. 安全性 → 设置 → 「浏览器完整性检查」
    关掉。这个功能会因 UA 与 TLS 指纹不匹配而拦爬虫 ——
    爬虫的 UA 说自己是 Googlebot，但 TLS 握手特征不是 Chrome，
    触发后返回 403。这是 Bot Fight Mode 关掉后最常见的残留原因。

 5. 安全性 → 设置 → 「Always Use HTTPS」
    开着没问题（http 会 301 到 https）。

 6. 规则 → 概述，看有没有正在生效的规则命中爬虫。

 7. 缓存 → 规则
    确认没有「绕过缓存 / Cache Everything」误配导致抓到空响应。

排查完在面板里点「测试」复验，或者回本脚本重跑。
EOF

echo
echo "═══════════════════════════════════════════════════════"
echo " 站长平台侧"
echo "═══════════════════════════════════════════════════════"
cat <<'EOF'
 · Search Console 的 403 若是历史遗留，点「重新验证」。
 · Bing Webmaster 有个设置叫「Block URL」/「阻止的 URL」，
   确认你的域名没被误加进去。
 · 两个平台的报错都带时间戳，对比服务器日志时间。
EOF
