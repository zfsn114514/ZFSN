/* ═══ 弹幕留言特效（独立模块：assets/js/danmaku.js）═══
 * 由 index.html 通过 <script src> 引入，依赖 window.ZFSN.api。
 *
 * 规则（当前版本）：
 *   · 只在首页出现，切到别的页面整层停掉
 *   · 屏幕上**同时最多 5 条**，一条飞完才补下一条（不再一次性铺一片）
 *   · 轨道随机分散，并尽量远离正在飞的其它弹幕，避免扎堆
 *   · 一轮里不重复同一条留言，观感更像"新弹幕"
 */
(function initDanmaku(){
  var layer = document.getElementById("danmaku-layer");
  var btn = document.getElementById("danmaku-toggle");
  if (!layer || !btn) return;

  var MAX_CONCURRENT = 5;   // 同屏上限
  var TRACK_H = 34;         // 每条轨道的高度
  var TOP_OFFSET = 60;      // 距顶留白（避开顶栏）
  var DUR_MIN = 14;         // 飞行时长（秒）
  var DUR_MAX = 26;

  var msgs = [];
  var running = false;
  var trackCount = 0;

  var active = [];     // 正在飞的：{ el, track, timer }
  var freeTracks = []; // 当前可用的轨道号
  var recent = [];     // 最近用过的留言下标，避免连续重复
  var timers = [];     // 待触发的补位定时器

  function calcTracks(){
    var maxH = Math.max(300, window.innerHeight - 120);
    trackCount = Math.max(1, Math.floor(maxH / TRACK_H));
    // 重新洗一遍可用轨道；正在飞的保留原轨道（不超过新轨道数）
    freeTracks = [];
    var used = {};
    active.forEach(function(it){
      if (it.track < trackCount) used[it.track] = 1;
    });
    for (var i = 0; i < trackCount; i++) if (!used[i]) freeTracks.push(i);

    // 窗口变矮时，把落在可视区外的弹幕拉回来
    active.forEach(function(it){
      if (it.track >= trackCount){
        it.track = Math.max(0, trackCount - 1);
        it.el.style.top = (it.track * TRACK_H + TOP_OFFSET) + "px";
      }
    });
  }

  /** 用户的开/关偏好（关闭状态记在 localStorage） */
  function wantOn(){
    return localStorage.getItem("zfsn_danmaku") !== "off";
  }

  /** 是否在首页。data-page 由主脚本的 setActive() 维护；
   *  拿不到就按首页处理（首次加载时属性可能还没写上）。 */
  function isHome(){
    return (document.body.getAttribute("data-page") || "home") === "home";
  }

  function fetchMsgs(){
    var api = (window.ZFSN && window.ZFSN.api) ? window.ZFSN.api : null;
    if (!api) { setTimeout(fetchMsgs, 1500); return; } // 主脚本还没就绪就稍后重试
    api("/api/messages?limit=80").then(function(d){
      msgs = (d && d.items) || [];
      if (msgs.length && !running && wantOn() && isHome()) {
        start();
      }
    }).catch(function(){});
  }

  /* 弹幕只在首页出现。切到别的页面就停掉，回来再启动 ——
   * 不停的话弹幕会在后台继续跑动画（白烧 CPU），
   * 而且回到首页时轨道占用记录已经过期，会重新铺一遍。
   * 注意：这里不写 localStorage，用户自己的开关偏好不能被页面切换冲掉。 */
  function onPageChange(){
    if (!isHome()) {
      if (running) stop();
      return;
    }
    if (!wantOn() || running) return;
    if (msgs.length) start();
    else fetchMsgs();
  }

  new MutationObserver(onPageChange).observe(document.body, {
    attributes: true,
    attributeFilter: ["data-page"]
  });

  /** 随机挑一条留言，尽量不和最近几条重复 */
  function pickMsg(){
    if (!msgs.length) return null;
    if (msgs.length === 1) return msgs[0];
    var keep = Math.min(3, msgs.length - 1);
    for (var t = 0; t < 12; t++){
      var i = Math.floor(Math.random() * msgs.length);
      if (recent.indexOf(i) < 0){
        recent.push(i);
        while (recent.length > keep) recent.shift();
        return msgs[i];
      }
    }
    recent = [];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  /** 从空闲轨道里选一条。
   *  只"随机取空位"还是会扎堆，所以再按「离最近占用轨道的距离」打分：
   *  越远分越高，再叠一点随机扰动。这样弹幕会自然铺开。 */
  function pickTrack(){
    if (!trackCount) return 0;
    if (!freeTracks.length) return Math.floor(Math.random() * trackCount);

    var busy = active.map(function(it){ return it.track; });
    var best = freeTracks[0], bestScore = -Infinity;
    for (var i = 0; i < freeTracks.length; i++){
      var t = freeTracks[i];
      var near = trackCount;
      for (var j = 0; j < busy.length; j++){
        var d = Math.abs(t - busy[j]);
        if (d < near) near = d;
      }
      var score = Math.min(near, 8) + Math.random() * 3.5;
      if (score > bestScore){ bestScore = score; best = t; }
    }
    var idx = freeTracks.indexOf(best);
    if (idx >= 0) freeTracks.splice(idx, 1);
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

  /** 放出 1 条弹幕；delay 秒后才起飞（用于初始错峰） */
  function spawn(delay){
    if (!running) return;
    var m = pickMsg();
    if (!m) return;

    var el = document.createElement("div");
    el.className = "danmaku-item";
    setContent(el, m);

    var track = pickTrack();
    var dur = DUR_MIN + Math.random() * (DUR_MAX - DUR_MIN);
    var it = { el: el, track: track };

    el.style.top = (track * TRACK_H + TOP_OFFSET) + "px";
    el.style.animation = "danmaku-move " + dur + "s linear " + (delay || 0) + "s both";
    layer.appendChild(el);
    active.push(it);

    el.addEventListener("animationend", function(){
      // 飞完 → 腾出轨道、补下一条（保证同屏始终不超过 MAX_CONCURRENT）
      var k = active.indexOf(it);
      if (k >= 0) active.splice(k, 1);
      el.remove();
      if (it.track >= 0 && freeTracks.indexOf(it.track) < 0) freeTracks.push(it.track);
      if (!running) return;
      // 错开一点再补，不然几条一起结束会同时冲进来
      var wait = 150 + Math.random() * 850;
      var tid = setTimeout(function(){
        timers = timers.filter(function(x){ return x !== tid; });
        spawn(0);
      }, wait);
      timers.push(tid);
    });
  }

  /** 补满到同屏上限 */
  function fill(stagger){
    var need = MAX_CONCURRENT - active.length;
    for (var i = 0; i < need; i++){
      spawn(stagger ? i * (0.35 + Math.random() * 0.5) : 0);
    }
  }

  function start(){
    if (running) return;
    if (!isHome()) return;   // 非首页一律不启动
    if (!msgs.length) return;
    running = true;
    active = [];
    recent = [];
    calcTracks();
    layer.classList.add("on");
    btn.classList.remove("off");
    // 开局错峰放出 5 条，之后每飞完一条补一条
    fill(true);
  }

  function stop(){
    running = false;
    layer.classList.remove("on");
    btn.classList.add("off");
    timers.forEach(clearTimeout);
    timers = [];
    active.forEach(function(it){ it.el.remove(); });
    active = [];
    calcTracks();
  }

  calcTracks();
  window.addEventListener("resize", calcTracks);

  btn.addEventListener("click", function(){
    if (!isHome()) return;   // 按钮在非首页是藏起来的，这里只是兜个底
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
