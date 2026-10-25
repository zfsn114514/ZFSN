#!/bin/sh
# 一锅端：起静态服务 + headless Edge + 截图脚本 + 收尾。
# 分开跑会失败：后台进程会随上一个 shell 结束被回收，下一个命令再来 curl 就是 502。
#
# ★ 静态服务用 tools/dev/serve.cjs（HTTP/1.1 + keep-alive + Range），
#   不用 python -m http.server：后者是 HTTP/1.0、每条响应 Connection: close，
#   连续取音效时会踩连接复用竞态，出现「第一个成功、后面全 204 空体」的假象。
set -u
cd /d/ZFSNwebsite || exit 1

NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PORT="${CDP_PORT:-9401}"
SERVE="${SERVE_PORT:-8900}"
SCRIPT="${1:-tools/dev/shot_minecraft.cjs}"

"$NODE" tools/dev/serve.cjs "$SERVE" "D:/ZFSNwebsite" >/tmp/mc-serve.log 2>&1 &
SRV=$!
i=0
code=000
while [ $i -lt 40 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$SERVE/minecraft/" 2>/dev/null)
  [ "$code" = "200" ] && break
  i=$((i+1)); sleep 0.5
done
echo "静态服务 :$SERVE → $code"

"$EDGE" --headless=new --remote-debugging-port="$PORT" --remote-allow-origins=* \
  --user-data-dir="D:/ZFSNwebsite/.tmp-mc/profile" --no-first-run --hide-scrollbars \
  about:blank >/dev/null 2>&1 &
i=0
while [ $i -lt 40 ]; do
  curl -s -o /dev/null --noproxy '*' "http://127.0.0.1:$PORT/json/version" 2>/dev/null && break
  i=$((i+1)); sleep 0.5
done
echo "调试端口 :$PORT 就绪"

# MC_URL 可由外部覆盖，指向线上站点做真实环境回归：
#   MC_URL=https://www.zfsnnb.dpdns.org/minecraft/ sh tools/dev/mc_shot.sh tools/dev/check_mc_full.cjs
CDP_PORT=$PORT MC_URL="${MC_URL:-http://127.0.0.1:$SERVE/minecraft/}" "$NODE" "$SCRIPT"
RC=$?

taskkill //F //IM msedge.exe >/dev/null 2>&1
kill $SRV 2>/dev/null
echo "--- exit $RC ---"
exit $RC
