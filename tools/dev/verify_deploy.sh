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
# 下载并校验完整性。
#
# ⚠ 只判 HTTP 状态码不够 —— 实测遇到过「返回 200 但内容被截断」：
#   首页 HTML 正常 36 KB，某个瞬间只下到 6 KB 就结束了，
#   于是下游所有基于 HTML 的检查（JS 引用、JSON-LD、meta）
#   全线误报「找不到」，看起来像部署出了问题，实际是网络抖动。
#   所以这里对 HTML/JS/CSS 这类文本资源加**最小体积校验 + 重试**：
#   小于 MIN_BYTES 就当作失败重下，三次都不行才认账。
#
# 用法：fetch <url> <输出文件> [最小字节数]
fetch() {
  local u="$1" out="${2:-/dev/null}" min="${3:-0}" code="" sz=0
  for i in 1 2 3; do
    code=$(curl -sL -o "$out" -w "%{http_code}" --max-time 45 -A "$UA" "$u" 2>/dev/null)
    if [ "$code" != "000" ]; then
      if [ "$min" -gt 0 ] && [ "$out" != "/dev/null" ]; then
        sz=$(wc -c < "$out" 2>/dev/null | tr -d ' ')
        if [ "${sz:-0}" -ge "$min" ]; then echo "$code"; return; fi
        # ⚠ 这里不能调 warn() —— 它写 stdout 会把计数和文本混进
        #   `$(fetch ...)` 的返回值里。直接写 stderr。
        printf '  \033[33m!\033[0m 下载只有 %sB（<%sB），重试 %s/3：%s\n' \
          "${sz:-0}" "$min" "$i" "$u" >&2
        sleep 2
        continue
      fi
      echo "$code"; return
    fi
    sleep 2
  done
  # 三次都拿不到完整内容：回一个非 200 的码，
  # 让下游 `[ "$C" = "200" ]` 直接判失败 —— 而不是拿着截断内容
  # 一路往下跑，最后报出一堆莫名其妙的「找不到 X」。
  if [ "$min" -gt 0 ] && [ "$out" != "/dev/null" ] && [ "${sz:-0}" -lt "$min" ]; then
    printf '  \033[31m✗\033[0m %s 三次均未拿到完整内容（末次 %sB < %sB）\n' \
      "$u" "${sz:-0}" "$min" >&2
    echo "598"   # 自定义码：内容不完整
    return
  fi
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
C=$(fetch "$SITE/" "$TMP/index.html" 20000)
[ "$C" = "200" ] && ok "首页 200" || bad "首页返回 $C" \
  "$([ "$C" = "598" ] && echo '下载内容不完整（非部署问题），重跑一次通常就好' || echo '')"

C=$(fetch "$SITE/pvz/pvz-portable" "$TMP/pvz.html" 5000)
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
    cs=$(fetch "$SITE/$p" "$TMP/js" 3000)
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
    cs=$(fetch "$SITE/$p" "$TMP/css" 5000)
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
C=$(fetch "$SITE/feed.xml" "$TMP/feed.xml" 500)
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
C=$(fetch "$SITE/robots.txt" "$TMP/robots.txt" 50)
[ "$C" = "200" ] && ok "robots.txt 200（跟随 307 后）" || bad "robots.txt 返回 $C"
grep -qi 'sitemap:' "$TMP/robots.txt" 2>/dev/null && ok "  robots 里声明了 sitemap" || warn "  robots 未声明 sitemap"

C=$(fetch "$SITE/sitemap.xml" "$TMP/sitemap.xml" 100)
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
  # ⚠ 体积取值要重试：沙箱网络偶发抖动时 curl 会返回空串，
  #   曾经把「avatar.jpg 可下载（22 KB）」误报成「体积异常（0 字节）」。
  SZ=""
  for _try in 1 2 3; do
    SZ=$(curl -sL -o /dev/null -w "%{size_download}" --max-time 45 -A "$UA" "$SITE/$f" 2>/dev/null)
    [ -n "$SZ" ] && [ "$SZ" -gt 500 ] 2>/dev/null && break
    sleep 2
  done
  if [ -n "$SZ" ] && [ "$SZ" -gt 500 ]; then
    ok "$f 可下载（$((SZ/1024)) KB, $IC）"
  else
    bad "$f 体积异常（${SZ:-0} 字节）"
  fi
done

# ══════════════════════════════════════════════════════════════
hdr "⑨ AVIF 择优加载（作品图）"
# ══════════════════════════════════════════════════════════════
#
# 为什么这几项重要：<picture> 只在「类型不匹配」时跳过 <source>，
# 若浏览器支持 AVIF 但文件缺失 / MIME 不对，它会**直接破图**而不回落。
# 所以 AVIF 副本的「存在 + MIME 正确 + 响应头不重复」必须逐项验证。
AVIFCOUNT=$(ls assets/works/*.avif 2>/dev/null | wc -l | tr -d ' ')
if [ "${AVIFCOUNT:-0}" -gt 0 ]; then
  AVSAMPLE=$(ls assets/works/*.avif 2>/dev/null | head -1)
  if [ -n "$AVSAMPLE" ]; then
    # ⚠ 状态码要接 head_only 的**返回值**（它 echo 出来），
    #   不要去 grep 下载到本地的图片文件 —— 那是二进制，抓不到状态码。
    ACODE=$(head_only "$SITE/$AVSAMPLE" "$TMP/avif")
    ACT=$(hdrval "$TMP/avif" "content-type")
    ACC=$(hdrval "$TMP/avif" "cache-control")
    if [ "$ACODE" = "200" ]; then
      ok "AVIF 副本可访问（$AVIFCOUNT 个，样本 $AVSAMPLE）"
    else
      bad "AVIF 样本返回 ${ACODE:-（空）}" "检查文件是否已提交并部署"
    fi
    # ⚠ 重复判定：`image/avif, image/avif` 是 Cloudflare 追加所致。
    #   不能笼统地用 *,* 判断 —— Cache-Control 本身天然含逗号。
    case "$ACT" in
      "image/avif") ok "  Content-Type: image/avif" ;;
      "image/avif, image/avif"|*"image/avif, "*)
        bad "  Content-Type 重复：$ACT" "_headers 里有两条规则同时命中，删掉子目录那条" ;;
      *) bad "  Content-Type 异常：${ACT:-（空）}" "应为 image/avif，否则 <picture> 会丢弃该候选" ;;
    esac
    # 同名头被追加时，整条 Cache-Control 会出现两次（中间以逗号相连）。
    # 判定方式：把值里的 `public` 计数，出现 2 次即重复。
    ACCN=$(printf '%s' "$ACC" | grep -o 'public' | wc -l | tr -d ' ')
    if [ "${ACCN:-0}" -gt 1 ]; then
      bad "  Cache-Control 重复（出现 ${ACCN} 次）：$ACC" "同上，Cloudflare 对同名头是追加"
    elif [ -n "$ACC" ]; then
      ok "  Cache-Control: $ACC"
    else
      warn "  Cache-Control 为空" "长缓存规则未生效"
    fi
  fi
else
  warn "仓库内没有 assets/works/*.avif" "若已执行 AVIF 落地，检查是否漏提交"
fi

# ══════════════════════════════════════════════════════════════
hdr "⑩ 「关于我」接口"
# ══════════════════════════════════════════════════════════════
#
# GET /api/about 是首页自我介绍的数据源。它是公开读接口，
# 线上必须返回 200 且是 {ok:true, text, has_content} 结构 ——
# 首页渲染依赖 has_content 决定要不要显示那一块。
#
# 踩坑提醒：`has_content` 必须是**布尔值**，不是字符串。
# 前端写的是 `if (!d.has_content) return;`（真值判断），
# 若后端误返回字符串 "false"，首页会把空内容当有内容渲染出来。
ACODE=$(fetch "$SITE/api/about" "$TMP/about")
if [ "$ACODE" = "200" ]; then
  if grep -q '"ok":true' "$TMP/about" 2>/dev/null; then
    ok "GET /api/about 200（结构正常）"
    if grep -qE '"has_content":(true|false)' "$TMP/about"; then
      ok "  has_content 是布尔值"
    else
      bad "  has_content 字段缺失或类型不对" "前端靠它判断是否显示，必须是布尔"
    fi
    if grep -qE '"text":"' "$TMP/about"; then
      ok "  含 text 字段"
    else
      bad "  缺少 text 字段" "首页正文取不到内容"
    fi
  else
    bad "  /api/about 返回体不是 {ok:true}" "看 $(cat "$TMP/about" 2>/dev/null | head -c 120)"
  fi
else
  bad "GET /api/about 返回 ${ACODE:-（空）}" "接口未部署或被拦截"
fi

# ⚠ --c1 这类「CSS 变量忘了定义」的坑必须线上验：
#   无 fallback 的 var(--undefined) 会让**整条声明失效**，
#   而且浏览器控制台一个字都不提示，本地看源码完全看不出来。
#   检查方式：拉下 CSS 确认 --c1 有定义，且没有满屏的 var(--c1) 裸引用。
CSSCUR=$(grep -oE 'assets/css/app\.[0-9a-f]{8}\.css' index.html | head -1)
if [ -n "$CSSCUR" ]; then
  fetch "$SITE/$CSSCUR" "$TMP/css" 5000 >/dev/null
  if grep -q -- '--c1:' "$TMP/css" 2>/dev/null; then
    ok "CSS 变量 --c1 已定义（${CSSCUR}）"
  else
    C1USE=$(grep -o 'var(--c1)' "$TMP/css" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${C1USE:-0}" -gt 0 ]; then
      bad "  --c1 未定义但有 ${C1USE} 处引用" "会导致竖线/装饰色整条声明失效，且控制台无提示"
    else
      ok "  未使用 --c1（无需定义）"
    fi
  fi
else
  warn "index.html 里找不到 app.<hash>.css 引用"
fi

# ══════════════════════════════════════════════════════════════
hdr "⑪ 留言板布局（grid，阅读顺序 = 时间顺序）"
# ══════════════════════════════════════════════════════════════
#
# 留言板最终选定 **grid 多列网格**（试过 CSS columns 和 JS 分列两轮后回退）。
# grid 的好处是 DOM 顺序 = 时间倒序，行内从左到右、换行往下，
# 天然满足「由左到右、由下到上、最旧在最下面」。
#
# ⚠ 必须线上验的理由：这一段历史上反复被改坏，且**坏得毫无征兆** ——
#   · 用 columns 时阅读顺序在列间乱跳（用户两次点名）
#   · 用 JS 分列时若 .gcol 规则缺失，页面照常渲染，只是全堆成一列
#   · grid 与 columns 同时存在时浏览器不报错，静默按后者走
#   光看「页面没崩」判断不出问题，得确认关键声明真的在。
JSCCUR=$(grep -oE 'assets/js/app\.[0-9a-f]{8}\.js' index.html | head -1)
if [ -n "$JSCCUR" ]; then
  fetch "$SITE/$JSCCUR" "$TMP/js" 3000 >/dev/null
  # grid 版不该再有分列逻辑；data-idx 保留给折叠判定与测试挂桩
  if grep -q 'data-idx' "$TMP/js" 2>/dev/null; then
    ok "JS 含 data-idx（折叠判定与测试挂桩用）"
  else
    warn "  未发现 data-idx" "折叠补判可能取不到卡片"
  fi
  if grep -q 'relayoutCols\|function distribute' "$TMP/js" 2>/dev/null; then
    bad "  JS 仍残留 JS 分列逻辑" "已回退到 grid，残留代码是死代码但会误导后来人"
  else
    ok "  JS 无残留分列逻辑（已回退 grid）"
  fi
else
  warn "index.html 里找不到 app.<hash>.js 引用"
fi

if [ -n "$CSSCUR" ]; then
  GLBLOCK=$(awk '/^\.glist\{/,/\}/' "$TMP/css" 2>/dev/null)
  if echo "$GLBLOCK" | grep -q 'display:grid'; then
    ok ".glist 是 grid（阅读顺序 = 时间顺序）"
  else
    bad "  .glist 不是 grid" "grid 才能保证「由左到右、由下到上」的时间顺序"
    echo "$GLBLOCK" | sed 's/^/      当前：/'
  fi
  # columns / flex 残留会静默覆盖 grid
  if echo "$GLBLOCK" | grep -qE 'column-width|display:flex'; then
    bad "  .glist 仍带 column-width 或 display:flex" "会静默覆盖 grid，实际布局不可预期"
  else
    ok "  .glist 无 columns/flex 残留"
  fi
  # 列宽定义（grid 的 minmax 目标列宽）
  if echo "$GLBLOCK" | grep -q 'minmax('; then
    ok "  列宽由 minmax 定义（$(echo "$GLBLOCK" | grep -o 'minmax([^)]*)' | head -1)）"
  else
    warn "  .glist 未见 minmax" "可能列宽未定义，列数会退化"
  fi
  # 留言卡 margin 必须为 0，否则与 grid 的 gap 叠加成双倍间距
  if awk '/^\.glist \.gitem\{/,/\}/' "$TMP/css" 2>/dev/null | grep -q 'margin:0'; then
    ok "  留言卡 margin 已归零（不与 grid gap 叠加）"
  else
    bad "  留言卡 margin 未归零" "窄屏 .gitem{margin:0 0 12px} 会叠加 gap，间距翻倍"
  fi
  # 作品墙是 columns、留言板是 grid，两者不能互相污染
  if grep -q '\.gcol' "$TMP/css" 2>/dev/null; then
    bad "  CSS 仍含 .gcol 规则" "回退 grid 后应删除列容器样式，否则误导后来人"
  else
    ok "  无 .gcol 残留（已回退 grid）"
  fi
fi

# ══════════════════════════════════════════════════════════════
# ══════════════════════════════════════════════════════════════
hdr "⑫ 关键子资源"
# ══════════════════════════════════════════════════════════════
# 图标：Google 抓 favicon 时优先在根路径找 /favicon.ico（只认位图，不认 SVG）
for f in "favicon.ico" "favicon-32.png" "favicon-16.png" "apple-touch-icon.png" "llms.txt" "assets/favicon.svg"; do
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
hdr "⑬ workers.dev 301 重定向"
# ══════════════════════════════════════════════════════════════
# 测重定向**必须带随机 query 绕过 CF 缓存**。
# ⚠ 实测踩坑：workers.dev 的 / 返回 200 且 CF-Cache-Status: HIT ——
#   那是**缓存里的旧版本**，代码其实已生效。不绕缓存就会误判成
#   「重定向没生效」并去改代码，改到天荒地老也是好的。
#   判据看 CF-Cache-Status: MISS/BYPASS 才是真打到 Worker 的。
# ══════════════════════════════════════════════════════════════
WORKERS="https://zfsn.zfsn114514.workers.dev"
probe() {   # probe <path> -> "状态码|Location|CF-Cache-Status"
  curl -sI --max-time 25 -A "$UA" "$WORKERS$1?cb=$RANDOM" 2>/dev/null \
    | tr -d '\r' \
    | awk '/^HTTP\/1.1 [0-9]/{c=$2} tolower($1)=="location:"{l=$2} tolower($1)=="cf-cache-status:"{s=$2} END{printf "%s|%s|%s", c, (l?l:"-"), (s?s:"-")}'
}

# 三个入口都要测：/ 是 index.html、/pvz/pvz-portable 是 pvz 目录页。
# ⚠ 这两个都是**已存在的静态文件**，若 wrangler.toml 的 run_worker_first
#   没把它们列进去，CF 静态资源层会优先返回，压根不进 Worker → 重定向无效。
# ★ 前提：wrangler.toml 的 [assets] 必须有 `binding = "ASSETS"`。
#   缺了它 env.ASSETS 是 undefined，Worker 侧一切静态请求都会 404。
for P in "/" "/pvz/pvz-portable"; do
  IFS='|' read -r CODE LOC CSTAT <<< "$(probe "$P")"
  if [ "$CODE" = "301" ] || [ "$CODE" = "308" ]; then
    ok "workers.dev$P 返回 $CODE（永久重定向，CF-Cache=$CSTAT）"
  elif [ "$CODE" = "000" ]; then
    warn "连不上 workers.dev（沙箱代理限制，见 MEMORY.md 踩坑 2），跳过"
    break
  else
    bad "workers.dev$P 返回 $CODE，期望 301（CF-Cache=$CSTAT）" \
        "若 CF-Cache 是 HIT/MISS，多半是缓存的旧版本；否则检查 run_worker_first 是否漏了这个 HTML 入口"
  fi
  case "$LOC" in
    *"$SITE"*) ok "  Location 指向规范域名：$LOC" ;;
    *)         bad "  Location 不对：$LOC" "重定向时必须保留 pathname" ;;
  esac
  # 深层链接必须保留 path，否则 /pvz/pvz-portable 这类链接会 404
  # ⚠ 上面 probe() 加了 ?cb=$RANDOM 绕缓存，Location 里必然带这个 query，
  #   所以判据是「去掉 query 后的路径前缀」而不是整串相等，否则每次都误报。
  LOC_PATH=${LOC%%\?*}
  case "$LOC_PATH" in
    "$SITE$P") : ;;
    *) bad "  Location 未保留路径：$LOC_PATH" "重定向必须保留 pathname，否则深层链接会 404" ;;
  esac
done

# 规范域名自身不能被重定向（否则会死循环）
SELF_CODE=$(curl -sI --max-time 25 -A "$UA" -o /dev/null -w "%{http_code}" "$SITE/" 2>/dev/null)
[ "$SELF_CODE" = "200" ] && ok "规范域名自身 200（无重定向死循环）" \
                          || bad "规范域名返回 $SELF_CODE，可能存在重定向循环"

# ★★★ HTML 页面必须始终 200 —— 整站 HTML 404 是事故级故障 ★★★
# 2026-10-05 真的发生过：为了修上面的 301 而加 assets.run_worker_first，
# 结果 / 与 /pvz/pvz-portable 全部 404（9 字节 "Not Found"）。
# ★ 真因**不是**「CF 静态层的无扩展名补全失效」（那个猜测是错的，
#   有 binding 时补全照常工作，已实测）。真因是 wrangler.toml 的 [assets]
#   **缺 binding = "ASSETS"** → env.ASSETS 是 undefined → fetch 抛 TypeError。
#   之所以潜伏很久：run_worker_first 没开时静态层自己就发了文件，
#   src/index.js 里的 serveAsset 压根没被走到。
# ⚠ 改 run_worker_first 之后**必须**跑这一段，否则「改了 CSS 没生效」
#   之类的误判会把你带偏 —— 实际是整站已经挂了。
for P in "/" "/pvz/pvz-portable" "/admin"; do
  B=$(curl -sL --max-time 25 -A "$UA" "$SITE$P?cb=$RANDOM" -o "$TMP/h.html" -w "%{http_code}")
  SZ=$(wc -c < "$TMP/h.html" | tr -d ' ')
  if [ "$B" = "200" ] && [ "${SZ:-0}" -gt 500 ] && grep -qi '<!doctype html' "$TMP/h.html"; then
    ok "HTML 页面 $P 正常（200, ${SZ}B）"
  else
    bad "HTML 页面 $P 返回 $B / ${SZ}B" \
        "若为 404，检查 wrangler.toml 的 assets.run_worker_first 是否被启用（它会让整站 HTML 失效）"
  fi
done

# ★★★ 图片 30 天长缓存必须保住 —— run_worker_first 写成全局 true 会毁掉它 ★★★
# 实测（隔离 wrangler dev 对照，2026-10-05）：
#   run_worker_first = true（全局） → 图片拿不到 _headers 的 Cache-Control，
#                                     退回 `max-age=0, must-revalidate`，缓存全废
#   run_worker_first = [路径列表]   → 图片仍走静态层，_headers 照常生效 ✅
# 所以 wrangler.toml 里必须是**路径列表**，不能是全局 true。
# 这一项就是防「有人图省事改成 true」的护栏。
PROBE_IMG=$(curl -s --max-time 25 -A "$UA" "$SITE/index.html?cb=$RANDOM" 2>/dev/null \
  | grep -oE 'assets/works/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)' | head -1)
if [ -z "$PROBE_IMG" ]; then
  PROBE_IMG="assets/favicon.svg"
fi
IMG_CC=$(curl -s -D - -o /dev/null --max-time 40 -A "$UA" "$SITE/$PROBE_IMG?cb=$RANDOM" 2>/dev/null \
  | tr -d '\r' | awk 'tolower($1)=="cache-control:"{c=$0} END{print c}')
if echo "$IMG_CC" | grep -q "2592000"; then
  ok "图片长缓存生效：$PROBE_IMG → $IMG_CC"
else
  bad "图片没有 30 天缓存：$PROBE_IMG → ${IMG_CC:-（无 Cache-Control）}" \
      "检查 wrangler.toml 的 run_worker_first 是否被改成了全局 true（会让 _headers 整体失效）"
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
