/* ═══ 弹幕留言特效（独立模块：assets/js/danmaku.js）═══
 * 由 index.html 通过 <script src> 引入，依赖 window.ZFSN.api。
 * 把原本内联在 index.html 里的弹幕逻辑抽出来，减小单体文件、便于维护。
 */
(function initDanmaku(){
  var layer = document.getElementById("danmaku-layer");
  var btn = document.getElementById("danmaku-toggle");
  if (!layer || !btn) return;

  var msgs = [];
  var items = [];
  var running = false;
  var trackCount = 0;
  var trackHeight = 0;
  var usedTracks = [];

  function calcTracks(){
    trackHeight = 34;
    var maxH = Math.max(300, window.innerHeight - 120);
    trackCount = Math.floor(maxH / trackHeight);
    usedTracks = new Array(trackCount).fill(0);
  }
  calcTracks();
  window.addEventListener("resize", calcTracks);

  function fetchMsgs(){
    var api = (window.ZFSN && window.ZFSN.api) ? window.ZFSN.api : null;
    if (!api) { setTimeout(fetchMsgs, 1500); return; } // 主脚本还没就绪就稍后重试
    api("/api/messages?limit=80").then(function(d){
      msgs = (d && d.items) || [];
      if (msgs.length && !running && localStorage.getItem("zfsn_danmaku") !== "off") {
        start();
      }
    }).catch(function(){});
  }

  function pickTrack(){
    // 找最近空闲的轨道，避免重叠
    var now = Date.now();
    var best = -1, bestT = Infinity;
    for (var i = 0; i < trackCount; i++){
      if (usedTracks[i] < now) {
        if (usedTracks[i] < bestT) { bestT = usedTracks[i]; best = i; }
      }
    }
    if (best < 0) best = Math.floor(Math.random() * trackCount);
    return best;
  }

  function setContent(el, m){
    el.textContent = "";
    if (m.name) {
      var nm = document.createElement("span");
      nm.className = "dm-name";
      nm.textContent = m.name + "：";
      el.appendChild(nm);
    }
    el.appendChild(document.createTextNode(m.text || ""));
  }

  function createItem(m, spread){
    var el = document.createElement("div");
    el.className = "danmaku-item";
    setContent(el, m);
    var track = pickTrack();
    var dur = 12 + Math.random() * 16; // 12-28 秒
    // 初始投放时给「负延迟」，让弹幕一开始就分散在屏幕上飞行（修复挤在一侧的 bug）；
    // 循环复用时延迟为 0，从右侧正常飘入。
    var delay = spread ? -(Math.random() * dur) : 0;
    el.style.top = (track * trackHeight + 60) + "px";
    el.style.animation = "danmaku-move " + dur + "s linear " + delay + "s both";
    // 标记轨道占用时间（到完全飘出左侧为止 + 预留）
    usedTracks[track] = Date.now() + (dur + delay) * 1000 + 2000;
    layer.appendChild(el);
    items.push(el);

    function onEnd(){
      if (!running) return;
      // 循环：重新随机一条留言
      if (msgs.length) {
        var next = msgs[Math.floor(Math.random() * msgs.length)];
        setContent(el, next);
        var newTrack = pickTrack();
        var newDur = 12 + Math.random() * 16;
        el.style.top = (newTrack * trackHeight + 60) + "px";
        el.style.animation = "none";
        el.offsetHeight; // force reflow
        el.style.animation = "danmaku-move " + newDur + "s linear 0s both";
        usedTracks[newTrack] = Date.now() + newDur * 1000 + 2000;
      }
    }
    el.addEventListener("animationend", onEnd);
  }

  function start(){
    if (running) return;
    running = true;
    layer.classList.add("on");
    btn.classList.remove("off");
    // 初始投放 8-14 条（spread=true：负延迟让它们一上来就铺满屏幕）
    var batch = Math.min(msgs.length, 8 + Math.floor(Math.random() * 7));
    for (var i = 0; i < batch; i++){
      createItem(msgs[Math.floor(Math.random() * msgs.length)], true);
    }
  }

  function stop(){
    running = false;
    layer.classList.remove("on");
    btn.classList.add("off");
    items.forEach(function(el){ el.remove(); });
    items = [];
  }

  btn.addEventListener("click", function(){
    if (running) {
      stop();
      localStorage.setItem("zfsn_danmaku", "off");
    } else {
      if (msgs.length) {
        start();
        localStorage.setItem("zfsn_danmaku", "on");
      } else {
        fetchMsgs();
      }
    }
  });

  // 页面加载后 2 秒开始拉留言并启动弹幕
  setTimeout(fetchMsgs, 2000);

  // 若用户上次是开着的，自动启动
  if (localStorage.getItem("zfsn_danmaku") !== "off") {
    setTimeout(fetchMsgs, 2500);
  }
})();
