#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  部署后自动验证
#  用法：bash tools/dev/verify_deploy.sh
#
#  为什么需要它：
#    每次 push 之后都得手动点一遍「首页能不能开、RSS 有没有、
#    统计接口通不通」。漏检一次就可能把坏版本带上线 ——
#    而且很多问题（缓存头、charset、307 跳转）不是肉眼能看出来的。
#
#  这一版覆盖了本轮所有改动：
#    内容哈希 JS / RSS / 结构化数据 / sitemap / 统计接口 /
#    自定义光标 / 图片压缩后的可用性 / charset / 缓存头
#
#  ⚠ 关于本机网络：这台机器出网走代理，curl 偶发返回 000。
#    所以每个请求都重试 3 次再判定，避免把代理抖动误报成站点故障。
#    （见 tools/dev/check-crawler.sh 里同类处理）
#
#  ⚠ 耗时提示：本脚本要发 ~20 个请求，且每个失败请求会重试。
#    经代理单次约 1~3s，**整体约 1~3 分钟**属正常，别用短 timeout 掐它。
# ══════════════════════════════════════════════════════════════
set -uo pipefail

SITE="${SITE:-https://www.zfsnnb.dpdns.org}"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# Python 解释器（用于可靠地抽取 JSON-LD 块；找不到就退回纯文本处理）
PY=""
for c in \
  "C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  "python3" "python" "py"; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

PASS=0; FAIL=0; WARN=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
warn() { WARN=$((WARN+1)); printf '  \033[33m!\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
hdr()  { printf '\n\033[1m══ %s\033[0m\n' "$1"; }

# ── 带重试的请求 ──────────────────────────────────────────────
# $1=url  $2=输出文件（可选）  回显 http 状态码
fetch() {
  local u="$1" out="${2:-/dev/null}" code=""
  for i in 1 2 3; do
    code=$(curl -sL -o "$out" -w "%{http_code}" --max-time 45 -A "$UA" "$u" 2>/dev/null)
    [ "$code" != "000" ] && { echo "$code"; return; }
    sleep 2
  done
  echo "$code"
}

# 只取响应头（不跟跳转），用于检查 307 之类的中间响应
head_only() {
  local u="$1" out="$2" code=""
  for i in 1 2 3; do
    code=$(curl -s -o "$out" -D "$out.h" -w "%{http_code}" --max-time 45 -A "$UA" "$u" 2>/dev/null)
    [ "$code" != "000" ] && { echo "$code"; return; }
    sleep 2
  done
  echo "$code"
}

hdrval() { grep -i "^$2:" "$1.h" 2>/dev/null | head -1 | sed 's/^[^:]*: *//' | tr -d '\r'; }

# ══════════════════════════════════════════════════════════════
hdr "① 基础可达性"
# ══════════════════════════════════════════════════════════════
C=$(fetch "$SITE/" "$TMP/index.html")
[ "$C" = "200" ] && ok "首页 200" || bad "首页返回 $C"

C=$(fetch "$SITE/pvz/pvz-portable" "$TMP/pvz.html")
[ "$C" = "200" ] && ok "游戏页 /pvz/pvz-portable 200" || bad "游戏页返回 $C"

# ══════════════════════════════════════════════════════════════
hdr "② charset（中文乱码的根因）"
# ══════════════════════════════════════════════════════════════
# 曾经的真实故障：静态层给的 text/html 不带 charset，
# Bing 把中文按 Latin-1 读 → og:description 变乱码。
CT=$(head_only "$SITE/" "$TMP/c")
# 注：head_only 把正文写 "$out"、响应头写 "$out.h"；
#     hdrval 内部会自己拼 ".h"，所以调用时**只传基础名**，别重复加 .h。
CTYPE=$(hdrval "$TMP/c" "content-type")
if echo "$CTYPE" | grep -qi "charset=utf-8"; then
  ok "首页 Content-Type 带 charset: $CTYPE"
else
  bad "首页 Content-Type 缺 charset" "$CTYPE"
fi

if grep -q '<meta charset="UTF-8">' "$TMP/index.html" 2>/dev/null; then
  ok "HTML 内有 <meta charset> 兜底"
else
  warn "HTML 内未见 <meta charset>"
fi

# ══════════════════════════════════════════════════════════════
hdr "③ 内容哈希的静态资源（JS + CSS）"
# ══════════════════════════════════════════════════════════════
# 从 HTML 里抽出带哈希的脚本路径，逐个取，必须 200
JSLIST=$(grep -oE 'src="assets/js/[^"]+"' "$TMP/index.html" 2>/dev/null | sed 's/src="//;s/"//')
if [ -z "$JSLIST" ]; then
  bad "HTML 里没找到任何 JS 引用"
else
  NJ=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    NJ=$((NJ+1))
    cs=$(fetch "$SITE/$p" "$TMP/js")
    if [ "$cs" = "200" ]; then
      if echo "$p" | grep -qE '\.[0-9a-f]{8}\.js$'; then
        ok "哈希脚本可访问：$p"
      else
        bad "脚本**没有**内容哈希：$p" "跑 tools/hash_assets.py"
      fi
    else
      bad "$p 返回 $cs" "检查文件是否已提交"
    fi
  done <<< "$JSLIST"
  [ "$NJ" -eq 0 ] && bad "JS 引用解析为空"
fi

# 长缓存头只对哈希文件生效
for p in $JSLIST; do
  case "$p" in
    *.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].js)
      head_only "$SITE/$p" "$TMP/hjs" >/dev/null
      CC=$(hdrval "$TMP/hjs" "cache-control")
      if echo "$CC" | grep -qi "immutable"; then
        ok "哈希脚本有长缓存：$CC"
      else
        warn "哈希脚本没拿到 immutable 缓存头" "$CC（检查 _headers 是否已提交）"
      fi
      ;;
  esac
done

# ── CSS：拆成外链后同样要有内容哈希与长缓存 ──
# 注意 CSS 的引用是 <link rel="stylesheet" href="...">，
# 不是 <script src>，所以必须单独抽一次。
CSSLIST=$(grep -oE 'href="assets/css/[^"]+\.css"' "$TMP/index.html" 2>/dev/null | sed 's/href="//;s/"//')
if [ -z "$CSSLIST" ]; then
  bad "HTML 里没找到任何 CSS 外链引用" "CSS 应已拆出为 assets/css/app.<hash>.css"
else
  for p in $CSSLIST; do
    cs=$(fetch "$SITE/$p" "$TMP/css")
    if [ "$cs" = "200" ]; then
      if echo "$p" | grep -qE '\.[0-9a-f]{8}\.css$'; then
        ok "哈希样式可访问：$p"
      else
        bad "样式**没有**内容哈希：$p" "跑 tools/hash_assets.py"
      fi
      # 内容必须是 CSS，不能是 404 页面或 HTML 错误页。
      # fetch() 不带 -D，不保存响应头，所以这里单独发一次 HEAD。
      head_only "$SITE/$p" "$TMP/hcss" >/dev/null
      CT=$(hdrval "$TMP/hcss" "content-type")
      if echo "$CT" | grep -qi "text/css"; then
        ok "样式 Content-Type 正确：$CT"
      else
        bad "样式 Content-Type 异常：${CT:-空}" "应返回 text/css"
      fi
      CC=$(hdrval "$TMP/hcss" "cache-control")
      if echo "$CC" | grep -qi "immutable"; then
        ok "哈希样式有长缓存：$CC"
      else
        warn "哈希样式没拿到 immutable 缓存头" "$CC（检查 _headers 是否已提交）"
      fi
      # CSS 里的光标是相对路径（../../assets/cursor/），拆分后最容易漏
      # 只做存在性提示，真正的 404 由 ⑧ 的光标检查兜底
    else
      bad "$p 返回 $cs" "检查文件是否已提交"
    fi
  done
fi

# HTML 本身**不应**带 immutable（内容会变，必须走协商缓存）
head_only "$SITE/" "$TMP/hhtml" >/dev/null
CC=$(hdrval "$TMP/hhtml" "cache-control")
if echo "$CC" | grep -qi "immutable"; then
  warn "首页拿到了 immutable 缓存头" "$CC（HTML 会变，不应长缓存）"
else
  ok "首页未长缓存（正确）：${CC:-无 Cache-Control}"
fi

# ══════════════════════════════════════════════════════════════
hdr "④ 结构化数据（JSON-LD）"
# ══════════════════════════════════════════════════════════════
if grep -q 'application/ld+json' "$TMP/index.html" 2>/dev/null; then
  ok "HTML 里有 JSON-LD"
  for t in '"Person"' '"WebSite"' '"ProfilePage"'; do
    if grep -q "$t" "$TMP/index.html"; then
      ok "  含 $t 节点"
    else
      bad "  缺 $t 节点"
    fi
  done
  if grep -q '"sameAs"' "$TMP/index.html"; then
    ok "  含 sameAs（关联 B站/Steam/Xbox）"
  else
    warn "  sameAs 缺失，实体关联会变弱"
  fi
  # 不应声明不存在的 SearchAction（hash 路由没有服务端搜索）。
  # ⚠ 必须**只看 JSON-LD 块内部**，不能用全文 grep：
  #   index.html 里有一行注释写着「刻意不写 SearchAction」，
  #   全文 grep 会命中注释而误报（本脚本踩过一次，见 commit 记录）。
  if [ -n "$PY" ]; then
    JSONLD_PART=$("$PY" -c "
import re,sys
html=open(r'$TMP/index.html',encoding='utf-8',errors='replace').read()
blocks=re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>',html,re.S)
sys.stdout.write('\n'.join(blocks))
" 2>/dev/null || echo "")
  else
    # 无 Python 时的近似兜底：取 ld+json 开标签到 </script> 之间的内容
    JSONLD_PART=$(sed -n '/application\/ld+json/,/<\/script>/p' "$TMP/index.html" 2>/dev/null || echo "")
    printf '      \033[2m(未找到 Python，JSON-LD 检查用近似方式)\033[0m\n'
  fi
  if printf '%s' "$JSONLD_PART" | grep -q 'SearchAction'; then
    warn "  声明了 SearchAction，但本站没有服务端搜索接口"
  else
    ok "  未声明无效的 SearchAction"
  fi
else
  bad "HTML 里没有 JSON-LD"
fi

# ══════════════════════════════════════════════════════════════
hdr "⑤ RSS 订阅源"
# ══════════════════════════════════════════════════════════════
C=$(fetch "$SITE/feed.xml" "$TMP/feed.xml")
if [ "$C" = "200" ]; then
  ok "feed.xml 200"
  if head -1 "$TMP/feed.xml" | grep -q '<?xml'; then ok "  有 XML 声明"; else bad "  缺 XML 声明"; fi
  if grep -q '<rss' "$TMP/feed.xml"; then ok "  是 RSS 2.0 结构"; else bad "  不是 RSS 结构"; fi
  NITEM=$(grep -c '<item>' "$TMP/feed.xml" 2>/dev/null || echo 0)
  if [ "$NITEM" -gt 0 ]; then
    ok "  含 $NITEM 个 item"
    # pubDate 必须是 RFC822（UTC），否则阅读器可能不认
    if grep -q '<pubDate>' "$TMP/feed.xml"; then
      if head -100 "$TMP/feed.xml" | grep -oE '<pubDate>[^<]*' | head -1 | grep -qE '(GMT|[+-][0-9]{4})$'; then
        ok "  pubDate 是 RFC822 时区格式"
      else
        bad "  pubDate 不是 RFC822 格式" "应为 toUTCString() 的输出"
      fi
    fi
  else
    warn "  feed 里还没有 item（作品库为空时会这样）"
  fi
else
  bad "feed.xml 返回 $C"
fi

# HTML 里的自动发现声明
if grep -q 'rel="alternate"' "$TMP/index.html" && grep -qi 'rss+xml' "$TMP/index.html"; then
  ok "HTML 里有 RSS 自动发现 <link>"
else
  bad "HTML 里缺 RSS 自动发现链接"
fi

# ══════════════════════════════════════════════════════════════
hdr "⑥ sitemap / robots"
# ══════════════════════════════════════════════════════════════
# ⚠ /robots.txt 这类特殊路径 CF 会做规范化，307 指向自身是正常的。
#   用 -L 跟随后应得 200，且只跳 1 次。不要因为看到 307 就判死循环。
C=$(fetch "$SITE/robots.txt" "$TMP/robots.txt")
[ "$C" = "200" ] && ok "robots.txt 200（跟随 307 后）" || bad "robots.txt 返回 $C"
grep -qi 'sitemap:' "$TMP/robots.txt" 2>/dev/null && ok "  robots 里声明了 sitemap" || warn "  robots 未声明 sitemap"

C=$(fetch "$SITE/sitemap.xml" "$TMP/sitemap.xml")
if [ "$C" = "200" ]; then
  ok "sitemap.xml 200"
  NURL=$(grep -c '<loc>' "$TMP/sitemap.xml" 2>/dev/null || echo 0)
  ok "  含 $NURL 个 URL"
  # sitemap 里的每个 URL 都必须真实可访问 —— 列了死链反而扣分
  DEAD=0
  while IFS= read -r loc; do
    [ -z "$loc" ] && continue
    lc=$(fetch "$loc" /dev/null)
    [ "$lc" != "200" ] && { DEAD=$((DEAD+1)); bad "  sitemap 里的 URL 不可访问（$lc）：$loc"; }
  done <<< "$(grep -oE '<loc>[^<]+' "$TMP/sitemap.xml" | sed 's/<loc>//')"
  [ "$DEAD" -eq 0 ] && ok "  sitemap 内 URL 全部可访问"
  # hash 片段不该出现在 sitemap（规范要求 loc 不含 fragment）
  if grep -qE '<loc>[^<]*#' "$TMP/sitemap.xml"; then
    bad "  sitemap 里含带 # 的 URL" "搜索忽略片段，属无效条目"
  else
    ok "  没有无效的 hash URL"
  fi
else
  bad "sitemap.xml 返回 $C"
fi

# ══════════════════════════════════════════════════════════════
hdr "⑦ 统计接口"
# ══════════════════════════════════════════════════════════════
# 这三个接口用 raws() 而不是裸 curl：本机走代理，裸 curl 偶发 000，
# 会被误报成"接口不存在/未登录"。raws 带重试，和上面的 fetch 一致。
raws() {
  # $1=url  $2=body文件  $3=method  $4=额外参数（可空）
  local u="$1" out="$2" m="${3:-GET}" extra="${4:-}" code=""
  for i in 1 2 3; do
    if [ "$m" = "POST" ]; then
      code=$(curl -s -o "$out" -w "%{http_code}" --max-time 30 -A "$UA" \
        -X POST -H 'content-type: application/json' -d '{"view":"home"}' "$u" 2>/dev/null)
    else
      code=$(curl -s -o "$out" -w "%{http_code}" --max-time 30 -A "$UA" "$u" 2>/dev/null)
    fi
    [ "$code" != "000" ] && { echo "$code"; return; }
    sleep 2
  done
  echo "$code"
}

# /api/pv 上报（正常应 200）
PCODE=$(raws "$SITE/api/pv" "$TMP/pv" POST)
if [ "$PCODE" = "200" ]; then
  PBODY=$(head -c 60 "$TMP/pv" 2>/dev/null | tr -d '\n')
  ok "/api/pv 200（$PBODY）"
elif [ "$PCODE" = "404" ]; then
  bad "/api/pv 返回 404" "Worker 未部署新版本？请确认 src/index.js 已上线"
else
  warn "/api/pv 返回 $PCODE" "若未执行 schema/0002_analytics.sql 会 500"
fi

# /api/stats 未登录必须 401（不能泄露数据）
SCODE=$(raws "$SITE/api/stats" "$TMP/st")
if [ "$SCODE" = "401" ]; then
  ok "/api/stats 未登录返回 401（正确）"
elif [ "$SCODE" = "404" ]; then
  warn "/api/stats 返回 404" "Worker 未部署新版本（尚未上线时可接受）"
elif [ "$SCODE" = "200" ]; then
  bad "/api/stats 未登录竟返回 200" "严重：统计数据在未授权时可读"
else
  warn "/api/stats 返回 $SCODE（期望 401）"
fi

# /api/health
HCODE=$(raws "$SITE/api/health" "$TMP/hh")
[ "$HCODE" = "200" ] && ok "/api/health 200" || warn "/api/health 返回 $HCODE"

# ══════════════════════════════════════════════════════════════
hdr "⑧ 自定义光标 + 图片（压缩后仍可用）"
# ══════════════════════════════════════════════════════════════
for f in arrow point; do
  C=$(fetch "$SITE/assets/cursor/$f.svg" /dev/null)
  if [ "$C" = "200" ]; then
    ok "光标 assets/cursor/$f.svg 200"
  elif [ "$C" = "404" ]; then
    warn "光标 $f.svg 返回 404" "尚未部署时可接受；已部署则检查 assets/cursor/ 是否已提交"
  else
    bad "光标 $f.svg 返回 $C"
  fi
done

# 抽查几张已压缩的图：必须还能正常解码（content-type 正确 + 有字节数）
for f in "assets/avatar.jpg" "assets/works/vrc.png"; do
  head_only "$SITE/$f" "$TMP/img" >/dev/null
  IC=$(hdrval "$TMP/img" "content-type")
  SZ=$(curl -sL -o /dev/null -w "%{size_download}" --max-time 45 -A "$UA" "$SITE/$f" 2>/dev/null)
  if [ -n "$SZ" ] && [ "$SZ" -gt 500 ]; then
    ok "$f 可下载（$((SZ/1024)) KB, $IC）"
  else
    bad "$f 体积异常（${SZ:-0} 字节）"
  fi
done

# ══════════════════════════════════════════════════════════════
hdr "⑨ 关键子资源"
# ══════════════════════════════════════════════════════════════
for f in "llms.txt" "assets/favicon.svg"; do
  C=$(fetch "$SITE/$f" /dev/null)
  [ "$C" = "200" ] && ok "$f 200" || warn "$f 返回 $C"
done

# 缺失资源必须 404 而不是 500（曾经 /llms.txt 缺失时报 500，被 PageSpeed 判不合格）
C=$(fetch "$SITE/this-file-should-not-exist-12345.txt" /dev/null)
if [ "$C" = "404" ]; then
  ok "缺失资源正确返回 404（不是 500）"
elif [ "$C" = "500" ]; then
  bad "缺失资源返回 500" "ASSETS 绑定异常，检查 serveAsset 的 catch"
else
  warn "缺失资源返回 $C（期望 404）"
fi

# ══════════════════════════════════════════════════════════════
printf '\n\033[1m══ 汇总\033[0m\n'
printf '  通过 \033[32m%d\033[0m  失败 \033[31m%d\033[0m  警告 \033[33m%d\033[0m\n' "$PASS" "$FAIL" "$WARN"
echo
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m部署验证失败 —— 上面标 ✗ 的必须先解决。\033[0m\n'
  exit 1
elif [ "$WARN" -gt 0 ]; then
  printf '\033[33m部署可用，但有 %d 条警告值得看一眼。\033[0m\n' "$WARN"
  exit 0
else
  printf '\033[32m全部通过。\033[0m\n'
  exit 0
fi
