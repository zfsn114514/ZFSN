/* ═══ 站点主逻辑（index.html 内联脚本拆出）═══
 * 原本内联在 index.html 里，约 79 KB，每次改一处都要重新下载整页 HTML。
 * 拆成独立文件后：HTML 可单独缓存、JS 命中浏览器缓存，改 JS 不再让 HTML 失效。
 *
 * 依赖顺序：本文件放在 danmaku.js 之前，且两者都用 defer ——
 * defer 脚本严格按文档顺序执行，保证 danmaku.js 读到 window.ZFSN.api 时已就绪。
 */
(function(){
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $  = function(s){ return document.querySelector(s); };
  var $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ═══ 粒子网络 ═══ */
  var cv = $("#bg"), ctx = cv.getContext("2d");
  var W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var pts = [], mouse = { x: -9999, y: -9999 };

  function resize(){
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.round(Math.min(120, (W * H) / 16000));
    pts = [];
    for (var i = 0; i < n; i++){
      pts.push({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - .5) * .32, vy: (Math.random() - .5) * .32,
        r: Math.random() * 1.5 + .6
      });
    }
  }

  var LINK = 132;
  /* 连线按距离分 3 档批量描边。
   * 旧写法对**每一对**粒子都单独 beginPath + stroke()，满屏能到上千次绘制调用，
   * 是 PageSpeed「最大限度地减少主线程工作 6.2 秒 / 强制自动重排」的主因。
   * 现在每档只 stroke 一次 —— 3 次绘制调用搞定，视觉上只是线的淡层次数变少。 */
  var TIER = [
    { lo: 0,   hi: 46,     a: .26 },
    { lo: 46,  hi: 88,     a: .16 },
    { lo: 88,  hi: LINK,   a: .08 }
  ];
  function draw(){
    ctx.clearRect(0, 0, W, H);

    // ① 只更新位置（顺带做鼠标斥力），不画任何东西
    for (var i = 0; i < pts.length; i++){
      var p = pts[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;

      var dxm = p.x - mouse.x, dym = p.y - mouse.y;
      var dm = Math.sqrt(dxm * dxm + dym * dym);
      p.near = dm < 190 ? (1 - dm / 190) : 0;
      if (dm < 130 && dm > 0.01){
        p.x += dxm / dm * .55;
        p.y += dym / dm * .55;
      }
    }

    // ② 连线：每档一次 beginPath + stroke
    ctx.lineWidth = .6;
    for (var t = 0; t < TIER.length; t++){
      var lo2 = TIER[t].lo * TIER[t].lo, hi2 = TIER[t].hi * TIER[t].hi;
      ctx.beginPath();
      var any = false;
      for (var a = 0; a < pts.length; a++){
        var pa = pts[a];
        for (var b = a + 1; b < pts.length; b++){
          var pb = pts[b];
          var dx = pa.x - pb.x, dy = pa.y - pb.y;
          var d2 = dx * dx + dy * dy;           // 先比平方，省掉开方
          if (d2 >= hi2 || d2 <= lo2) continue;
          ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
          any = true;
        }
      }
      if (!any) continue;
      ctx.strokeStyle = "rgba(150,158,178," + TIER[t].a + ")";
      ctx.stroke();
    }

    // ③ 粒子：普通 / 被鼠标点亮 两批，各 fill 一次
    for (var pass = 0; pass < 2; pass++){
      ctx.beginPath();
      var got = false;
      for (var k = 0; k < pts.length; k++){
        var pk = pts[k], nr = pk.near || 0;
        if ((pass === 1) !== (nr > 0)) continue;
        var r = pk.r + nr * 1.6;
        ctx.moveTo(pk.x + r, pk.y);            // 不 moveTo 会连出直线
        ctx.arc(pk.x, pk.y, r, 0, 6.2832);
        got = true;
      }
      if (!got) continue;
      ctx.fillStyle = pass === 1
        ? "rgba(255,90,115,.9)"
        : "rgba(160,166,186,.5)";
      ctx.fill();
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  if (!reduce) draw();
  else {
    ctx.fillStyle = "rgba(160,166,186,.35)";
    pts.forEach(function(p){ ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill(); });
  }

  /* ═══ 鼠标拖尾 ═══ */
  var tc = $("#trail"), tctx = tc.getContext("2d");
  var tails = [], TMAX = 26;
  /* 拖尾是柔和的径向渐变光斑，1 倍像素比看不出差别，但每帧要清整屏 ——
   * dpr=2 时每帧要抹掉 4 倍像素，这里直接按 1 倍开，省掉 3/4 的填充开销。 */
  var tdpr = 1;
  function sizeTrail(){
    tc.width = window.innerWidth * tdpr; tc.height = window.innerHeight * tdpr;
    tctx.setTransform(tdpr, 0, 0, tdpr, 0, 0);
  }
  sizeTrail();
  window.addEventListener("resize", sizeTrail);

  var lastX = null, lastY = null;
  function trailLoop(){
    /* 没有拖尾时什么都不画：上一帧已经把画布清干净了，
     * 空转的 clearRect(全屏) 在高分屏上也是实打实的带宽浪费。 */
    if (tails.length){
      tctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (!reduce){
        for (var i = tails.length - 1; i >= 0; i--){
          var t = tails[i];
          t.life -= .028;
          if (t.life <= 0){ tails.splice(i, 1); continue; }
          t.x += t.vx; t.y += t.vy;
          t.vx *= .95; t.vy *= .95;
          var rr = t.r * t.life;
          var g = tctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, rr * 3.4);
          g.addColorStop(0, "rgba(255,90,115," + (t.life * .5) + ")");
          g.addColorStop(.45, "rgba(255,45,74," + (t.life * .16) + ")");
          g.addColorStop(1, "rgba(255,45,74,0)");
          tctx.fillStyle = g;
          tctx.beginPath(); tctx.arc(t.x, t.y, rr * 3.4, 0, 6.2832); tctx.fill();
        }
      }
    }
    requestAnimationFrame(trailLoop);
  }
  trailLoop();

  /* ═══ 指针事件 ═══ */
  function pointerMove(x, y){
    mouse.x = x; mouse.y = y;
    if (reduce) return;
    if (lastX === null){ lastX = x; lastY = y; }
    var dx = x - lastX, dy = y - lastY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.min(Math.ceil(dist / 7), 4);
    for (var s = 0; s < steps; s++){
      var f = steps > 1 ? (s + 1) / steps : 1;
      tails.push({
        x: lastX + dx * f, y: lastY + dy * f,
        vx: dx * .055 + (Math.random() - .5) * .9,
        vy: dy * .055 + (Math.random() - .5) * .9,
        r: 2.6 + Math.random() * 1.9,
        life: 1
      });
    }
    if (tails.length > TMAX) tails.splice(0, tails.length - TMAX);
    lastX = x; lastY = y;
  }

  window.addEventListener("mousemove", function(e){ pointerMove(e.clientX, e.clientY); });
  window.addEventListener("mouseleave", function(){ mouse.x = -9999; mouse.y = -9999; lastX = null; lastY = null; });
  window.addEventListener("touchmove", function(e){
    if (e.touches[0]) pointerMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });

  /* ═══ 光标光晕 ═══ */
  var glow = $("#glow");
  var gx = window.innerWidth / 2, gy = window.innerHeight / 2, tX = gx, tY = gy;
  window.addEventListener("mousemove", function(e){ tX = e.clientX; tY = e.clientY; });
  /* 位置用 transform 而不是 left/top：后者每帧改动都会触发布局 + 重绘，
   * 鼠标一动就是一次强制重排（PageSpeed 明确点了这条）。transform 走合成器。
   * 居中由 CSS 的 margin:-310px 0 0 -310px 负责（620px 直径的一半），
   * 这里只管鼠标坐标的位移，不要在这里再减半径，否则会偏移两次。 */
  glow.style.transform = "translate3d(" + gx + "px," + gy + "px,0)";
  (function follow(){
    var nx = gx + (tX - gx) * .12, ny = gy + (tY - gy) * .12;
    if (Math.abs(nx - gx) > .05 || Math.abs(ny - gy) > .05){   // 静止时不再写样式
      gx = nx; gy = ny;
      glow.style.transform = "translate3d(" + gx.toFixed(1) + "px," + gy.toFixed(1) + "px,0)";
    }
    requestAnimationFrame(follow);
  })();

  /* ═══ 卡片聚光 + 3D 倾斜 ═══
   * getBoundingClientRect() 是强制布局的经典触发点：在 mousemove 里读它，
   * 等于每挪一下鼠标就强制浏览器重算一次布局。卡片位置在悬停期间是固定的，
   * 所以进卡片时量一次存起来复用即可。
   *
   * 聚光和倾斜共用同一个矩形缓存和同一个 mousemove 监听 ——
   * 两者都需要"鼠标相对卡片的位置"，各写一份监听会让 mousemove 里
   * 的逻辑跑两遍，白白多一次 getBoundingClientRect 命中的机会。
   */
  /* 倾斜的最大角度。给到 7deg 时卡片边缘会明显"翘起来"，
     再大就开始有廉价 PPT 动画的味道；7 是既有立体感又不轻浮的甜点值。 */
  var TILT_MAX = 7;
  var canTilt = window.matchMedia("(hover: hover) and (pointer: fine)").matches && !reduce;

  $$(".card").forEach(function(c){
    var r = null;
    var inner = c.querySelector(".c3d");
    c.addEventListener("mouseenter", function(){
      r = c.getBoundingClientRect();
      if (canTilt && inner) c.classList.add("tilting");
    });
    c.addEventListener("mouseleave", function(){
      r = null;
      if (!inner) return;
      c.classList.remove("tilting");
      // 移出时把角度归零，靠 CSS 的 .5s 过渡平滑回正
      inner.style.setProperty("--rx", "0deg");
      inner.style.setProperty("--ry", "0deg");
      inner.style.setProperty("--hx", "0px");
    });
    c.addEventListener("mousemove", function(e){
      if (!r) r = c.getBoundingClientRect();

      // 归一化到 [-.5, .5]，中心为 0
      var px = (e.clientX - r.left) / r.width  - .5;
      var py = (e.clientY - r.top)  / r.height - .5;

      // 聚光圆点（原有行为）
      c.style.setProperty("--mx", (e.clientX - r.left) + "px");
      c.style.setProperty("--my", (e.clientY - r.top) + "px");

      if (!canTilt || !inner) return;

      /* 方向推导：鼠标往右走，卡片应当"右边翘起来" —— 也就是绕 Y 轴正转？
         不，视觉上要的是**左边后仰、右边前倾**，对应 rotateY 取正值。
         写成 +px 会让卡片顺着鼠标方向转，像被推着跑；
         取负号则是卡片"迎向"指针，更像一块被手指按住的玻璃。
         这里用负号（迎向指针），立体感和交互感都更强。
         rotateX 同理：鼠标在下半部 → 卡片上部后仰，py 为正 → 取正号。 */
      var ry = -px * TILT_MAX * 2;
      var rx =  py * TILT_MAX * 2;

      inner.style.setProperty("--rx", rx.toFixed(2) + "deg");
      inner.style.setProperty("--ry", ry.toFixed(2) + "deg");
      // 高光横向偏移，跟着鼠标在卡片表面扫动
      inner.style.setProperty("--hx", (px * 120).toFixed(0) + "px");
    });
  });

  /* ═══ 打字机 ═══ */
  var lines = [
    "Silver hair. Red oni. Zero limits.",
    "\u4e8c\u6b21\u5143 / \u6e38\u620f / \u521b\u4f5c",
    "Welcome to my corner of the internet."
  ];
  var el = $("#typed");
  if (reduce){ el.textContent = lines[0]; }
  else {
    var li = 0, ci = 0, del = false;
    (function tick(){
      var s = lines[li];
      if (!del){
        ci++;
        el.textContent = s.slice(0, ci);
        if (ci === s.length){ del = true; return setTimeout(tick, 1900); }
        setTimeout(tick, 62);
      } else {
        ci--;
        el.textContent = s.slice(0, ci);
        if (ci === 0){ del = false; li = (li + 1) % lines.length; return setTimeout(tick, 320); }
        setTimeout(tick, 28);
      }
    })();
  }

  /* ═══ 3D 头像翻转 ═══ */
  var stage = $("#stage");
  var flipLock = false;
  function flip(){
    if (flipLock) return;
    flipLock = true;
    stage.classList.toggle("flipped");
    setTimeout(function(){ flipLock = false; }, 1050);
  }
  stage.addEventListener("click", flip);
  stage.addEventListener("mouseenter", function(){ if (!flipLock) stage.classList.add("flipped"); });
  stage.addEventListener("mouseleave", function(){ stage.classList.remove("flipped"); });

  /* ═══ 页面切换 ═══ */
  var wipe = $("#wipe");
  var pages = {
    home: $("#page-home"), works: $("#page-works"), work: $("#page-work"),
    bili: $("#page-bili"), steam: $("#page-steam"), guest: $("#page-guest")
  };
  var navBtns = $$(".nav button");
  var current = "home";
  var switching = false;

  function setActive(key){
    $$(".page").forEach(function(p){ p.classList.remove("active"); });
    if (pages[key]) pages[key].classList.add("active");
    // 作品详情页属于"作品"这一栏，导航高亮要跟着走
    var navKey = (key === "work") ? "works" : key;
    navBtns.forEach(function(b){ b.classList.toggle("active", b.dataset.go === navKey); });
    current = key;
    // 告诉 CSS（和 assets/js/danmaku.js）现在在哪一页：
    // 弹幕只在首页显示，靠这个属性收敛。
    document.body.setAttribute("data-page", key);
    window.scrollTo(0, 0);
    // 切到作品页时刷新一次 —— 保证后台新加的作品马上可见，
    // 也顺带同步最新的点赞/评论数。
    if (key === "works" && window.__zfsnLoadGallery) window.__zfsnLoadGallery();
    countView(key);
  }

  /* ═══ 访问上报（第一方统计）═══
   * 关键约束：**绝不能影响页面切换的观感**。
   * 所以：
   *   · 不 await，不阻塞任何流程
   *   · 失败静默（统计失败不该弹错误给用户）
   *   · 同一路径在同一会话里只报一次 —— 用户来回切页面不该刷高 PV
   *   · 用 sessionStorage 记住已报路径；隐私模式下不可用时退化为每次上报
   *
   * 为什么前端上报而不是服务端统计：
   *   本站是单页应用，所有页面共用一个 URL（`/`），
   *   服务端只能看到「有人访问了 /」，区分不出他看的是首页还是作品页。
   *   只有前端知道用户实际停在哪一屏，所以上报必须由前端发起。
   */
  var PV_KEY = "zfsn_pv_reported";

  function countView(key){
    if (!key || key === "work" && !window.__zfsnWorkId) return;

    var view = key;
    // work 页要带作品 ID，否则统计不出「哪件作品被看得多」
    var workId = (key === "work") ? window.__zfsnWorkId : "";

    // 会话内去重。把 workId 拼进去，这样同一会话看多个不同作品都会各计一次
    var tag = view + (workId ? ":" + workId : "");
    try {
      var done = JSON.parse(sessionStorage.getItem(PV_KEY) || "[]");
      if (done.indexOf(tag) >= 0) return;
      done.push(tag);
      sessionStorage.setItem(PV_KEY, JSON.stringify(done));
    } catch (e) { /* 隐私模式：不记，照常上报 */ }

    // 必须把上报放到「后端地址已探测完成」之后 ——
    // 直接 fetch("/api/pv") 在 CF 静态站上会打到静态资源层（404），
    // api() 内部会先 ensure 探测结果，这里复用它。
    api("/api/pv", {
      method: "POST",
      body: JSON.stringify({ view: view, workId: workId })
    }).catch(function(){ /* 静默 */ });
  }

  function go(key){
    if (switching || key === current || !pages[key]) return;
    switching = true;
    if (reduce){ setActive(key); switching = false; return; }
    document.body.classList.add("locked");
    wipe.classList.add("on");
    setTimeout(function(){
      setActive(key);
      wipe.classList.remove("on");
      document.body.classList.remove("locked");
      setTimeout(function(){ switching = false; }, 320);
    }, 340);
  }

  navBtns.forEach(function(b){ b.addEventListener("click", function(){ go(b.dataset.go); }); });
  $(".topbar .mark").addEventListener("click", function(){ go("home"); });

  // 首页三平台概览卡 → 点击跳转到对应页面
  $$(".hs-card").forEach(function(c){
    c.addEventListener("click", function(){ go(c.dataset.go); });
  });

  /* ═══ 地址栏路由（作品详情可分享）═══
   * #work/<id>    → 打开该作品详情页
   * 其它 / 空     → 普通页面切换
   *
   * 用 hash 而不是 history.pushState：静态站部署在任意子目录下都不用改
   * 服务器配置，刷新也不会 404。
   */
  function openWorkById(id){
    if (!id) return;
    if (current === "work" && window.__zfsnWorkId === id) return;
    go("work");
    if (window.__zfsnLoadWork) window.__zfsnLoadWork(id);
  }

  function routeFromHash(){
    var h = (location.hash || "").replace(/^#/, "");
    var m = h.match(/^work\/([a-f0-9]+)$/i);
    if (m) { openWorkById(m[1]); return; }
    if (pages[h]) { go(h); return; }
    go("home");
  }

  window.__zfsnOpenWork = function(id){
    // 写进地址栏，这样复制出去的链接别人打开就是同一件作品
    if (("#work/" + id) !== location.hash){
      try { location.hash = "work/" + id; return; }   // hashchange 会接手
      catch (e) {}
    }
    openWorkById(id);
  };

  window.addEventListener("hashchange", routeFromHash);

  /* ═══ 顶栏滚动状态 ═══
   * 滚过一定距离后给 .topbar 加 .scrolled：背景变实、内边距收缩、加下边框。
   *
   * 为什么不用 `window.addEventListener("scroll")`：
   *   scroll 事件在主线程上触发，滚动过程中每帧都可能回调一次，
   *   里面再读 scrollTop 就会引起强制同步布局（layout thrashing）——
   *   在低端机上这个开销肉眼可见。
   *   IntersectionObserver 把判断交给浏览器合成线程，JS 只在
   *   「哨兵元素跨过阈值」时被叫醒一次，滚动过程中零开销。
   *
   * 哨兵是一个插在页面最顶部的空 div（高度 1px），它滚出视口
   * 就说明用户已经滚了一段距离。
   */
  (function initTopbarScroll(){
    var bar = $(".topbar");
    if (!bar) return;
    // 哨兵：绝对定位在文档最顶，不占布局高度
    var sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText =
      "position:absolute;top:0;left:0;width:1px;height:90px;pointer-events:none;visibility:hidden";
    document.body.appendChild(sentinel);
    new IntersectionObserver(function(entries){
      // isIntersecting=false → 哨兵滚出视口 → 已滚过 90px
      bar.classList.toggle("scrolled", !entries[0].isIntersecting);
    }, { threshold: 0 }).observe(sentinel);
  })();

  window.__zfsnApplyRoute = function(){
    var h = (location.hash || "").replace(/^#/, "");
    var m = h.match(/^work\/([a-f0-9]+)$/i);
    if (m){
      setActive("work");
      if (window.__zfsnLoadWork) window.__zfsnLoadWork(m[1]);
      return;
    }
    if (pages[h]) setActive(h);
  };

  /* ═══ 作品展示墙 ═══
   * 数据来源：后端 /api/works（后台「作品管理」里添加的）。
   * 没有作品时显示空状态，**不再**用演示数据冒充真实作品。
   */
  var gallery = $("#gallery");

  /* ── 轻量提示条（点赞失败等场景用） ── */
  var _toastTimer = null;
  function toast(msg, isErr){
    var el = $("#ztoast");
    if (!el){
      el = document.createElement("div");
      el.id = "ztoast";
      el.className = "ztoast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "ztoast on" + (isErr ? " err" : "");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function(){ el.className = "ztoast"; }, 2600);
  }

  // 没有图片时用本地生成的 SVG 渐变图占位
  var WPAL = [
    ["#ff2d4a", "#2a0510"], ["#39d5ff", "#04141d"], ["#ff6b7f", "#1a0410"],
    ["#c9cdd9", "#0d0d14"], ["#a855f7", "#120424"], ["#0ea5e9", "#03121f"],
    ["#3fd63f", "#04160a"], ["#ffb547", "#1f1103"]
  ];
  function grad(c1, c2){
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="600">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/>' +
      '</linearGradient>' +
      '<radialGradient id="r" cx=".72" cy=".24" r=".75">' +
      '<stop offset="0" stop-color="' + c1 + '" stop-opacity=".85"/>' +
      '<stop offset="1" stop-color="' + c1 + '" stop-opacity="0"/></radialGradient></defs>' +
      '<rect width="480" height="600" fill="' + c2 + '"/>' +
      '<rect width="480" height="600" fill="url(#g)" opacity=".55"/>' +
      '<rect width="480" height="600" fill="url(#r)"/>' +
      '<g fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1">' +
      '<circle cx="340" cy="180" r="86"/><circle cx="340" cy="180" r="132" stroke-dasharray="3 7"/>' +
      '<path d="M0 470 Q120 400 240 455 T480 420"/><path d="M0 520 Q140 455 250 505 T480 470"/>' +
      '</g></svg>';
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function placeholder(i){ var c = WPAL[i % WPAL.length]; return grad(c[0], c[1]); }

  /* ═══ 图片渐进加载（blur-up）═══
   *
   * 要解决的问题：作品图是**用户上传的原图**，单张可能一两百 KB。
   * 在弱网或首次访问时，卡片位置会先空着，图片到达后「啪」地跳出来 ——
   * 观感上很生硬，且如果图还没下载完就撑开了高度，还会引起布局跳动。
   *
   * 做法（不依赖任何后端能力，纯前端）：
   *   ① 先用一张**几 KB 的 SVG 渐变**当 src —— 网络代价接近 0，
   *      但足以让容器立刻有色块，不出现空白
   *   ② 图片元素带 .pimg 类 → CSS 给它 blur(14px) + 轻微放大
   *   ③ 真实图片用 new Image() 在后台预载（**不**占用可见 <img> 的 src，
   *      所以不会打断占位图的显示，也不会有半截图的撕裂感）
   *   ④ 真图 onload → 换 src、加 .pimg-on → CSS 过渡到清晰状态
   *   ⑤ 预载失败（比如图片被删了）→ 保留占位图，不显示破图
   *
   * 为什么不用后端生成 LQIP / 缩略图：
   *   本站图片走 Cloudflare 静态资源层直出，没有图片处理 Worker。
   *   引入图片处理管线（Cloudflare Images 等）要额外计费，
   *   而这个「渐变占位 + 淡入」的方案零成本，80% 的观感收益已经拿到。
   *
   * 与 loading="lazy" 的关系：保留 lazy。浏览器会先渲染 data: URI 占位
   * （不算网络请求），把真图请求推迟到接近视口时才发 —— 两者不冲突。
   */
  function blurUp(imgEl, realSrc, paletteIdx){
    if (!imgEl) return;
    // 记录调色板位次，供 CSS 里的降级兜底（无 JS 时仍是可看的渐变色块）
    imgEl.setAttribute("data-pi", String(paletteIdx | 0));
    imgEl.classList.add("pimg");
    imgEl.src = placeholder(paletteIdx);

    var real = new Image();
    // 解码在后台线程做，避免图片一到达就在主线程解码造成掉帧
    if ("decode" in real) {
      real.decoding = "async";
    }
    real.onload = function(){
      imgEl.src = realSrc;
      // 写回真实宽高 —— 防 CLS，与 fillNaturalSize 同一套思路
      if (real.naturalWidth && real.naturalHeight){
        imgEl.setAttribute("width", real.naturalWidth);
        imgEl.setAttribute("height", real.naturalHeight);
      }
      // 下一帧再加 class，保证 transition 真的被触发（同一帧内改 src 又改
      // class 的话，浏览器可能合并成一次样式计算，过渡会丢失）
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){ imgEl.classList.add("pimg-on"); });
      });
    };
    real.onerror = function(){
      // 真图挂了：留在占位图上，并标记出来便于排查
      imgEl.setAttribute("data-perr", "1");
    };
    real.src = realSrc;
  }

  /**
   * 把图片的真实像素宽高写回 width/height 属性（用于防 CLS）。
   *
   * 为什么需要：CSS 里的 aspect-ratio 只能处理「宽高比固定」的容器。
   * 作品大图、灯箱大图是用户上传的，宽高比什么都有，没法在 CSS 里写死。
   * 而一旦 <img> 带了 width/height 属性，浏览器在图片字节到达前就能
   * 按 width:100% + height:auto 推出占位高度 —— 图片解码后不产生跳动。
   *
   * 两类情况都要处理：
   *   · 已缓存/已解码 → naturalWidth 立即有值，直接写
   *   · 首次加载 → 立刻写不了，挂 load 事件，加载完再写
   */
  function fillNaturalSize(img){
    if (!img) return;
    function apply(){
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      // 只在缺失时写，避免覆盖 HTML 里已给出的正确值
      if (!img.getAttribute("width")) img.setAttribute("width", w);
      if (!img.getAttribute("height")) img.setAttribute("height", h);
    }
    if (img.complete && img.naturalWidth) apply();
    else img.addEventListener("load", apply, { once: true });
  }

  /** 单张图片路径归一化（兼容后台可能填的绝对路径） */
  function imgPath(p, i){
    var src = String(p || "").trim().replace(/\\/g, "/");
    // 把 D:\ZFSNwebsite\assets\xx.jpg → assets/xx.jpg
    var m = src.match(/[\\/]ZFSNwebsite[\\/](.+)$/i);
    if (m) src = m[1].replace(/\\/g, "/");
    if (!src) return placeholder(i || 0);
    return src;
  }

  // 作品图片路径兼容：后台可能填绝对路径（D:\...），浏览器无法直接加载，
  // 这里自动转换成站点内的相对路径。
  function workImg(w, i){
    return imgPath(w.cover, i);
  }

  /* AVIF 择优加载（<picture> 降级链）。
     ────────────────────────────────────────────────────────────
     背景：图片主文件保留了原扩展名（.jpg/.png），内容其实已是 WebP。
     对**首屏与详情页大图**额外产出了同名 .avif 副本（省约 40% 体积）。
     浏览器支持 AVIF 就下更小的那份，不支持（如 Safari < 16.4）自动回落主文件。

     为什么用 <picture> 而不是直接改 img.src：
       <picture><source> 是浏览器**原生**的择优机制 —— 它在解析 HTML 时
       就决定下载哪个候选，不需要 JS 先探测再换 URL（那样会多一次请求）。
       而且与现有 blurUp() 零冲突：实测 img.src 被 blurUp 换成占位图后，
       浏览器依旧按 <source> 选 currentSrc（详见 docs/avif-evaluation.md）。

     用法：把 `<img …>` 换成 pictureHtml(url, imgAttrsHtml)。
       原图路径经 imgPath 归一化后可能仍是 data: URI（占位）或绝对 URL，
       这两种情况**不产 AVIF**，直接原样返回 <img>，避免拼出无效 srcset。

     ⚠⚠ 只对**确实存在 .avif 副本**的目录开候选（见 avifCandidate 的白名单）。
       不能对没有副本的目录也包 <picture> —— 因为 <picture> 的降级语义是
       「**类型/条件不匹配**时跳过 <source>」，**不是**「加载失败后回主文件」。
       实测：把 .avif 请求全改成网络失败（BlockedByClient）后，浏览器
       停在 currentSrc=.avif 且 naturalWidth=0，直接破图，**不会回落**。
       所以「文件不存在 / MIME 不对」= 用户看到破图，必须在源头杜绝。
       （真正不支持 AVIF 的老浏览器是另一回事：它会在解析阶段就跳过
         <source>，压根不发请求，那条链路是安全的。） */
  function avifCandidate(url){
    // ⚠ 只对**仓库内**的静态图片（assets/ 开头）生成候选。
    //   后端媒体路径（media/... 走 API_BASE 拼前缀）没有 .avif 副本，
    //   若也拼一个出来，浏览器会发一次注定 404 的请求再回落 ——
    //   实测第一件作品的封面就是 media/works/image/xxx.jpg，
    //   曾被错拼成 .avif 造成无用请求（transferSize 仅 309B 的 404）。
    if (!url || /^(data:|blob:)/i.test(url)) return null;
    // 只认「已生成 .avif 副本」的目录。目前只有 assets/works/ 有，
    // 其他目录（bili / xbox / steam / 头像）没有 —— 若也拼出候选，
    // 就是一次注定 404 的请求。将来扩展目录时，这里加白名单即可。
    if (url.indexOf("assets/works/") !== 0) return null;
    var m = /^(.*)\.(jpe?g|png|webp)$/i.exec(url);
    if (!m) return null;
    return m[1] + ".avif";
  }

  /** 把 <img> 包进 <picture>（带 AVIF 候选）。
   *  attrs 是拼好的 <img> 属性串（不含 src），src 单独传。
   *  不满足条件时退回普通 <img>，行为与改造前完全一致。
   *
   *  ── 为什么要挂 onerror 兜底 ──────────────────────────────
   *  <picture> 只在「类型不匹配」时跳过 <source>；若浏览器**支持** AVIF
   *  但文件缺失 / MIME 不对 / 网络失败，它**不会**回主文件，而是直接破图。
   *  实测已复现（见 docs/avif-evaluation.md 的降级链实测）。
   *
   *  兜底做法：img 解出来的图若失败（naturalWidth 仍为 0），就摘掉同级的
   *  <source> 并把 src 重新指回主文件 —— 此时浏览器只能选主文件，成功加载。
   *  只在真的出错时才多一次请求，正常路径零开销。 */
  function pictureHtml(src, attrs){
    var avif = avifCandidate(src);
    if (!avif) return '<img src="' + esc(src) + '" ' + attrs + '>';
    return '<picture>' +
             '<source type="image/avif" srcset="' + esc(avif) + '">' +
             '<img src="' + esc(src) + '" ' + attrs +
               ' onerror="__zfsnAvifFallback(this)"' +
             '>' +
           '</picture>';
  }

  /** AVIF 候选加载失败时的兜底：摘掉 <source>，强制回落主文件。
   *  全局暴露（HTML 属性里调用），幂等 —— 第二次失败不再处理，避免死循环。 */
  window.__zfsnAvifFallback = function(img){
    if (!img || img.__avifFb) return;
    img.__avifFb = 1;
    var pic = img.parentElement;
    if (pic && pic.tagName === "PICTURE") {
      var srcs = pic.querySelectorAll("source");
      for (var i = 0; i < srcs.length; i++) {
        if ((srcs[i].getAttribute("type") || "").indexOf("avif") >= 0) srcs[i].remove();
      }
    }
    var real = img.getAttribute("src");     // 主文件（.jpg/.png）
    if (real) {
      img.removeAttribute("src");
      img.setAttribute("src", real);        // 重新触发一次选择，这次只剩主文件
    }
  };

  /* 媒体地址（视频 / 下载文件）——
     这类文件**不在 git 仓库里**（几十 MB 的视频塞进仓库会拖慢每次构建），
     它们存在家里服务器上，由后端经 Cloudflare 隧道流式提供。
     所以这里必须拼到后端主机（API_BASE）上，而不是站点相对路径。
     图片则相反：走站点相对路径 → 命中 Cloudflare 上的仓库副本，最快。 */
  function mediaUrl(rel){
    var s = String(rel || "").trim().replace(/\\/g, "/");
    if (!s) return "";
    if (/^(https?:|data:|\/)/.test(s)) return s;
    var b = (typeof API_BASE === "string" && API_BASE) ? API_BASE : "";
    return b + "/" + s;
  }

  /** 下载地址：走 /api/download/:workId/:idx，能保留原始文件名 */
  function dlUrl(workId, idx){
    var b = (typeof API_BASE === "string" && API_BASE) ? API_BASE : "";
    return b + "/api/download/" + workId + "/" + idx;
  }

  /** 字节数 → 人类可读 */
  function fmtSize(n){
    var b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  }

  /** 从文件名里取一个用于图标的小标签（ZIP / PDF / PSD …） */
  function fileTag(name){
    var m = String(name || "").match(/\.([a-z0-9]{1,6})$/i);
    return m ? m[1].toUpperCase().slice(0, 4) : "FILE";
  }

  var ICON_HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  var ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>';
  var ICON_PICS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>' +
    '<path d="M21 15l-5-5L5 21"/></svg>';
  var ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
  var ICON_SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>' +
    '<path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>';

  /** 拉取作品列表并渲染 */
  function loadGallery(){
    // 统一走 api()：它内部会先确保后端地址已探测出来，
    // 不会出现"探测还没完成就发请求"的竞态。
    api("/api/works").then(function(d){
      GALLERY_CACHE = (d && d.items) || [];
      buildTagBar(GALLERY_CACHE);
      gApplyFilter();
    }).catch(function(e){
      // 作品墙是多列布局，占满宽度要用 column-span（不能用 grid-column）
      gallery.innerHTML = '<div class="wcmt-empty" style="column-span:all">' +
        '作品加载失败：' + esc(e.message || "未知错误") + '</div>';
    });
  }

  /* ═══ 作品筛选（搜索 + 标签）═══
   *
   * 全部在前端做。作品列表本来就是一次性拉全量的（/api/works 返回完整数组），
   * 所以筛选只是对内存里的数组做 filter —— 不发请求、不闪加载态，
   * 输入时逐字符过滤也不会卡。
   *
   * 两个条件是**与**关系：选了标签「绘画」再搜「猫」，
   * 得到的是「既属于绘画、又匹配猫」的作品。
   *
   * ⚠ 命名必须带 g 前缀：本文件所有代码同处一个 IIFE 作用域，
   *   而函数声明会提升、**同名者后者覆盖前者**。Steam 页那套游戏筛选
   *   也叫 applyFilter()（见下方 steam 区块），若两者同名，
   *   整个作品墙筛选会被静默替换成游戏筛选 —— 表现为「搜索/标签全无反应」，
   *   且不报任何错。改名前踩过这个坑。
   */
  var GALLERY_CACHE = [];   // 全量作品（声明提前到 loadGallery 之前用）
  var gFilterTag = "";      // 当前选中的标签，空串 = 全部
  var gFilterText = "";     // 当前搜索词（已转小写）

  /** 某作品是否命中当前筛选条件 */
  function gMatchWork(w){
    if (gFilterTag && String(w.tag || "") !== gFilterTag) return false;
    if (!gFilterText) return true;
    // 标题 / 标签 / 描述 三个字段一起匹配 —— 用户搜「pvz」时
    // 可能作品标题里没有，但描述里提到了
    var hay = [w.title, w.tag, w.desc]
      .map(function(s){ return String(s || "").toLowerCase(); })
      .join("\n");
    return hay.indexOf(gFilterText) >= 0;
  }

  /** 应用筛选并渲染（注意：不要命名成 applyFilter，会撞车游戏筛选） */
  function gApplyFilter(){
    var list = GALLERY_CACHE.filter(gMatchWork);
    // 两个视图共用同一份筛选结果 —— 切换视图不该丢筛选条件，
    // 也不该重新请求后端。哪个显示由 gView 决定。
    if (gView === "timeline"){
      renderTimeline(list);
    } else {
      renderGallery(list);
    }
    gUpdateCount(list.length, GALLERY_CACHE.length);
  }

  /* ═══ 视图切换（作品墙 / 时间线）═══ */
  var gView = "wall";     // "wall" | "timeline"

  /** 切换视图：只切显隐，不重拉数据 */
  function gSetView(v){
    if (v !== "wall" && v !== "timeline") v = "wall";
    if (v === gView) return;
    gView = v;

    var wall = $("#gallery"), tl = $("#gtimeline");
    if (wall) wall.hidden = (v !== "wall");
    if (tl) tl.hidden = (v !== "timeline");

    $$(".gviewbtn").forEach(function(b){
      var on = b.getAttribute("data-view") === v;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });

    gApplyFilter();
  }

  /** 虚拟滚动占位：作品少于这个数就一次性渲染完 */
  var TL_BATCH = 80;

  /**
   * 时间线渲染：按 年 → 月 分组，组内按时间倒序。
   *
   * 时间字段用哪个？作品有两个：
   *   ts   —— 毫秒时间戳，可靠但不可读
   *   time —— 后端给的格式化字符串（如 "2026-10-02 03:33"）
   * 分组的依据必须是可解析的时间。优先 ts（数值最稳），
   * ts 缺失时退回解析 time 字符串。两者都没有的作品归到"更早"一组，
   * 而不是丢掉 —— 宁可归错组也不能让作品凭空消失。
   */
  function renderTimeline(list){
    var box = $("#gtimeline");
    if (!box) return;

    if (!list.length){
      box.innerHTML = '<div class="gempty">' +
        '<div class="big">🔍</div>' +
        (gFilterTag || gFilterText
          ? '没有匹配的作品<br>试试换个关键词，或点上面的「全部」清除筛选'
          : '还没有作品') +
        '</div>';
      return;
    }

    // 解析出时间戳
    var rows = list.map(function(w){
      var t = Number(w.ts) || 0;
      if (!t && w.time){
        // "2026-10-02 03:33" → iOS Safari 对带空格的格式解析不稳，
        // 换成 ISO 风格的 T 分隔，并补上时区（按本地时区理解）
        var d = new Date(String(w.time).replace(" ", "T"));
        if (!isNaN(d.getTime())) t = d.getTime();
      }
      return { w: w, t: t };
    });

    // 时间倒序（新的在上）。ts 为 0 的（没时间）沉到最后。
    rows.sort(function(a, b){ return b.t - a.t; });

    var html = "";
    var lastYear = null, lastMon = null;
    var shown = 0;

    rows.forEach(function(r){
      var w = r.w;
      var d = r.t ? new Date(r.t) : null;
      var y = d ? d.getFullYear() : "更早";
      var m = d ? (d.getMonth() + 1) : null;

      if (shown >= TL_BATCH){
        return;   // 超过批量的先不渲染（下方统一给"加载更多"）
      }

      if (y !== lastYear){
        html += '<div class="gtl-year">' + esc(String(y)) + '</div>';
        lastYear = y; lastMon = null;
      }
      if (m !== null && m !== lastMon){
        html += '<div class="gtl-mon">' + m + ' 月</div>';
        lastMon = m;
      }

      var dateTxt = d
        ? (m + "月" + d.getDate() + "日 " +
           String(d.getHours()).padStart(2, "0") + ":" +
           String(d.getMinutes()).padStart(2, "0"))
        : "时间未知";

      html +=
        '<div class="gtl-item' + (w.cover ? '' : ' gtl-notxt') + '" data-id="' + esc(w.id) + '" role="link" tabindex="0">' +
          // 无图作品：不放占位缩略图（同作品墙的处理，见上面 .gitem-txt 的注释）
          (w.cover
            ? '<div class="gtl-thumb"><img src="' + esc(workImg(w, 0)) +
              '" alt="' + esc(w.title) + '" loading="lazy"></div>'
            : '') +
          '<div class="gtl-body">' +
            '<div class="gtl-t">' + esc(w.title) + '</div>' +
            '<div class="gtl-d">' +
              (w.tag ? '<span class="tag">' + esc(w.tag) + '</span>' : '') +
              (w.likes ? '<span>♥ ' + w.likes + '</span>' : '') +
              (w.comments ? '<span>💬 ' + w.comments + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="gtl-date">' + esc(dateTxt) + '</div>' +
        '</div>';
      shown++;
    });

    box.innerHTML = html;

    // 点击 → 进详情页
    box.querySelectorAll(".gtl-item").forEach(function(el){
      function openIt(){ if (window.__zfsnOpenWork) window.__zfsnOpenWork(el.getAttribute("data-id")); }
      el.addEventListener("click", openIt);
      // 键盘可达：时间线条目是 role=link + tabindex，Enter/Space 要能用
      el.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " "){ e.preventDefault(); openIt(); }
      });
    });
  }

  /** 结果计数：只在「有筛选条件」时显示，否则纯属噪音 */
  function gUpdateCount(shown, total){
    var box = $("#gcount");
    if (!box) return;
    var filtering = gFilterTag || gFilterText;
    if (!filtering){
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = '找到 <b>' + shown + '</b> 件作品' +
      (gFilterText ? '，关键词「' + esc(gFilterText) + '」' : '') +
      (gFilterTag ? '，标签「' + esc(gFilterTag) + '」' : '') +
      '　共 ' + total + ' 件';
  }

  /** 从作品数据里统计标签，渲染成可点的筛选条 */
  function buildTagBar(list){
    var bar = $("#gtags");
    if (!bar) return;
    // 统计每个标签有多少件作品
    var counts = {};
    list.forEach(function(w){
      var t = String(w.tag || "").trim();
      if (t) counts[t] = (counts[t] || 0) + 1;
    });
    var tags = Object.keys(counts).sort(function(a, b){
      // 按作品数从多到少，同数量按名称 —— 常用的标签排在前面更容易点
      return counts[b] - counts[a] || a.localeCompare(b, "zh");
    });
    if (!tags.length){
      // 一条标签都没有时，整条筛选栏没有意义，直接藏掉（只留搜索框）
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML =
      '<button type="button" class="gtag on" data-tag="">全部<span class="n">' +
        list.length + '</span></button>' +
      tags.map(function(t){
        return '<button type="button" class="gtag" data-tag="' + esc(t) + '">' +
          esc(t) + '<span class="n">' + counts[t] + '</span></button>';
      }).join("");
  }

  /** 绑定搜索框 / 标签栏 / 视图切换的事件（只需绑一次） */
  (function initGalleryFilter(){
    // 视图切换（作品墙 ↔ 时间线）
    $$(".gviewbtn").forEach(function(b){
      b.addEventListener("click", function(){ gSetView(b.getAttribute("data-view")); });
    });

    var bar = $("#gtags");
    if (bar){
      bar.addEventListener("click", function(e){
        var b = e.target.closest(".gtag");
        if (!b) return;
        gFilterTag = b.getAttribute("data-tag") || "";
        bar.querySelectorAll(".gtag").forEach(function(x){
          x.classList.toggle("on", x === b);
        });
        gApplyFilter();
      });
    }
    var input = $("#gsearch");
    var clear = $("#gclear");
    if (input){
      input.addEventListener("input", function(){
        gFilterText = input.value.trim().toLowerCase();
        if (clear) clear.hidden = !input.value;
        gApplyFilter();
      });
      // Esc 清空 —— 搜索框的通用习惯
      input.addEventListener("keydown", function(e){
        if (e.key === "Escape" && input.value){ input.value = ""; input.dispatchEvent(new Event("input")); }
      });
    }
    if (clear){
      clear.addEventListener("click", function(){
        input.value = ""; gFilterText = ""; clear.hidden = true;
        gApplyFilter(); input.focus();
      });
    }
  })();

  /** 卡片上的媒体角标：几张图 / 有视频 / 几个附件 */
  function badgeHtml(w){
    var parts = [];
    var n = (w.images || []).length;
    if (n > 1) parts.push('<span>' + ICON_PICS + n + ' 张</span>');
    if (w.video) parts.push('<span>' + ICON_VIDEO + '视频</span>');
    var nf = (w.files || []).length;
    if (nf) parts.push('<span>' + ICON_DL + nf + ' 个附件</span>');
    return parts.length ? '<div class="gbadge">' + parts.join("") + '</div>' : "";
  }

  function renderGallery(list){
    if (!list.length){
      // 两种情况要分开说 —— 「一件都没有」和「筛没筛出来」
      // 对用户是完全不同的信息，文案混用会让人以为站点没内容
      if (gFilterTag || gFilterText){
        gallery.innerHTML = '<div class="gempty">' +
          '<div class="big">🔍</div>' +
          '没有匹配的作品<br>' +
          '试试换个关键词，或点上面的「全部」清除筛选' +
          '</div>';
      } else {
        gallery.innerHTML = '<div class="wcmt-empty" style="column-span:all">' +
          '还没有作品 — 在后台「作品管理」里添加后会显示在这里</div>';
      }
      return;
    }
    gallery.innerHTML = "";
    list.forEach(function(w, i){
      var el = document.createElement("div");
      // 无图作品：加 .gitem-txt 变体，卡片按文字自然撑高，不塞占位图
      el.className = "gitem reveal" + (w.cover ? "" : " gitem-txt");
      el.style.animationDelay = (i * .06) + "s";
      var img = workImg(w, i);
      el.innerHTML =
        (w.tag ? '<span class="pill">' + esc(w.tag) + '</span>' : '') +
        '<div class="gacts">' +
          '<button class="gact" data-like="' + w.id + '" title="点赞">' +
            ICON_HEART + '<span class="n">' + (w.likes || 0) + '</span></button>' +
          '<button class="gact" data-cmt="' + w.id + '" title="评论">' +
            ICON_CHAT + '<span class="n">' + (w.comments || 0) + '</span></button>' +
        '</div>' +
        // ★ 无图时不渲染 <img>：以前 imgPath() 会兜底成一张 480×600 的
        //   SVG 渐变（红色那块），既难看又白占一大块版面。
        //   现在改成纯文字卡片，高度完全由标题 + 简介的行数决定。
        (w.cover
          ? pictureHtml(img, 'alt="' + esc(w.title) + '" loading="lazy" decoding="async"')
          : '') +
        '<div class="gmeta">' +
          badgeHtml(w) +
          '<div class="gt">' + esc(w.title) + '</div>' +
          (w.desc ? '<div class="gs">' + esc(w.desc) + '</div>' : '') +
        '</div>';

      // 渐进加载：先上 SVG 渐变占位，真图在后台预载完再淡入
      // （无图作品没有 <img>，跳过）
      var _imgEl = el.querySelector("img");
      if (_imgEl) blurUp(_imgEl, img, i);

      // 点卡片主体 → 进入作品详情页
      // （详情页里能看到完整大图、简介、点赞数，以及**所有人的评论**；
      //   原来只是弹个灯箱放大图，别人评了什么完全看不到。）
      el.addEventListener("click", function(e){
        if (e.target.closest(".gact")) return;    // 点赞/评论按钮不触发跳转
        if (window.__zfsnOpenWork) window.__zfsnOpenWork(w.id);
      });

      gallery.appendChild(el);
    });

    // 绑定点赞
    gallery.querySelectorAll("button[data-like]").forEach(function(b){
      b.addEventListener("click", function(e){
        e.stopPropagation();
        doLike(b.getAttribute("data-like"), b);
      });
    });
    // 绑定评论：直接跳到详情页的评论区。
    // 详情页里有完整的"谁评论了、评论了什么"，还能看大图和点赞，
    // 比在卡片上弹一个小窗更符合"每个人都想看别人说了什么"的诉求。
    gallery.querySelectorAll("button[data-cmt]").forEach(function(b){
      b.addEventListener("click", function(e){
        e.stopPropagation();
        if (window.__zfsnOpenWork) window.__zfsnOpenWork(b.getAttribute("data-cmt"));
      });
    });
  }

  /** 点赞 / 取消点赞 */
  function doLike(workId, btn){    btn.disabled = true;
    api("/api/works/" + workId + "/like", { method: "POST" })
      .then(function(d){
        btn.disabled = false;
        btn.classList.toggle("on", !!d.liked);
        // 作品墙的按钮数字在 .n 里，详情页的在 #wd-like-n / #wd-s-like 里。
        // 用 closest 判断自己在哪个页面，别让两处的 DOM 结构互相绑定。
        var n = btn.querySelector(".n") || btn.querySelector("span");
        if (n) n.textContent = d.likes;
        var sLike = $("#wd-s-like");
        if (sLike) sLike.textContent = d.likes;
        btn.classList.remove("like-bump", "bump");
        void btn.offsetWidth;                  // 强制重排以重启动画
        btn.classList.add(btn.classList.contains("wd-like") ? "bump" : "like-bump");
        // 更新内存里的数据，切换页面回来时数字不会回退
        GALLERY_CACHE.forEach(function(x){ if (x.id === workId) x.likes = d.likes; });
      })
      .catch(function(e){
        btn.disabled = false;
        toast(e.message || "点赞失败", true);
      });
  }

  /* ═══ 分享作品 ═══
   * 三级降级，覆盖所有浏览器：
   *   ① navigator.share —— 手机/部分桌面上唤起系统分享面板（微信、QQ、AirDrop…）
   *   ② navigator.clipboard.writeText —— 桌面浏览器主流方案，复制链接
   *   ③ document.execCommand("copy") —— 老浏览器 / 非安全上下文（http 下
   *      clipboard API 不可用）的兜底，虽然已废弃但仍是唯一能用的办法
   *
   * 为什么要用 navigator.share 优先：在手机上复制链接再切 App 粘贴的体验很差，
   * 系统分享面板一步到位。但**桌面 Chrome 也实现了 share()**（会弹系统对话框），
   * 有些人觉得那个对话框很烦 —— 不过它只有用户主动点"分享"才会出现，
   * 属于预期行为，所以仍然优先用。
   *
   * ⚠ navigator.share 在用户取消时会抛 AbortError，这不是失败，不能弹错误提示。
   */
  function shareWork(w, btn){
    var url = location.origin + location.pathname + "#work/" + w.id;
    var text = (w.title || "作品") + " — ZFSN";

    function done(msg){
      if (btn){
        btn.classList.add("shared");
        setTimeout(function(){ btn.classList.remove("shared"); }, 1400);
      }
      toast(msg);
    }

    function fallbackCopy(){
      // ③ execCommand 兜底。需要一个真实可聚焦的临时 textarea，
      //    且必须留在文档里（display:none 的节点选不中）。
      var ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, url.length);   // iOS 上 select() 有时选不全
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok ? "链接已复制，粘贴给朋友即可" : "复制失败，请手动复制地址栏链接");
    }

    // ① 系统分享面板
    if (navigator.share){
      navigator.share({ title: w.title || "ZFSN 作品", text: text, url: url })
        .then(function(){ done("已分享"); })
        .catch(function(err){
          // 用户主动取消 → 静默，别弹"分享失败"打扰他
          if (err && err.name === "AbortError") return;
          // 其它错误（比如浏览器不支持这个字段组合）→ 退到复制
          fallbackCopy();
        });
      return;
    }

    // ② 剪贴板 API（需要 https 或 localhost，否则 navigator.clipboard 为 undefined）
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url)
        .then(function(){ done("链接已复制，粘贴给朋友即可"); })
        .catch(fallbackCopy);
      return;
    }

    fallbackCopy();
  }

  /* ── 归属地图标 ──
   * 作品评论已迁到详情页（见下方 #page-work 的渲染逻辑），
   * 这里只留公共的小工具函数。
   */
  function geoIcon(){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  }

  /** 重新拉一次列表刷新点赞/评论数（发表评论后用） */
  function refreshCounts(){
    api("/api/works").then(function(d){
      var list = (d && d.items) || [];
      GALLERY_CACHE = list;
      list.forEach(function(w){
        var lb = gallery.querySelector('button[data-like="' + w.id + '"] .n');
        var cb = gallery.querySelector('button[data-cmt="' + w.id + '"] .n');
        if (lb) lb.textContent = w.likes || 0;
        if (cb) cb.textContent = w.comments || 0;
      });
    }).catch(function(){});
  }

  // GALLERY_CACHE 的声明已提到前面（筛选逻辑要用到），这里不再重复声明
  // 由 detectAPI() 完成后统一触发加载（见下方 __zfsnOnAPIReady 注册）
  // 这里只登记一个"待加载"标记，避免 API_BASE 尚未探测就发请求。
  window.__zfsnLoadGallery = loadGallery;

  /* ═══════════ 作品详情页 ═══════════
   * 需求：任何人都能点进作品，看到大图、简介，以及**谁评论了、评论了什么**。
   * 之前点卡片只是弹灯箱放大图 —— 评论藏在另一个入口里，别人根本看不到。
   */
  var wdRoot = $("#wd-root");
  window.__zfsnWorkId = null;

  function loadWork(id){
    window.__zfsnWorkId = id;
    wdRoot.innerHTML =
      '<div class="wd-layout">' +
        '<div class="wd-media"><div class="skeleton" style="aspect-ratio:4/5"></div></div>' +
        '<div class="wd-side"><div class="skeleton" style="height:200px"></div></div>' +
      '</div>';
    api("/api/works/" + id)
      .then(function(d){ renderWork(d); })
      .catch(function(e){
        wdRoot.innerHTML = '<div class="wdc-empty">' +
          '作品加载失败：' + esc(e.message || "未知错误") +
          '<br><br>它可能已经被删除了。</div>';
      });
  }
  window.__zfsnLoadWork = loadWork;

  /* ── 作品详情页的结构化数据 ──────────────────────────────────
   * 首页那份 JSON-LD 是写死在 HTML 里的（爬虫不执行 JS，必须静态存在）。
   * 但作品是后台随时增删的，没法写死 —— 只能在打开详情页时由 JS 注入。
   *
   * 现实预期：hash 路由（`/#work/<id>`）本身不可被单独收录，所以这段
   * 标记**大概率不会被搜索引擎读到**。它的价值有二：
   *   ① 若将来改成真实路径路由（/work/<id>），这段直接可用；
   *   ② 对会执行 JS 的抓取方（部分 AI 爬虫、社交平台预览）有效，
   *      能拿到标题/简介/封面，而不是一个空白页。
   * 也就是说：这是「顺手做对」，不是「SEO 翻盘手」。
   *
   * 用 <script> 插在 <head> 而不是 body：符合规范位置，
   * 且用 dataset 打标便于重复打开不同作品时替换而不是堆积。
   */
  function injectWorkJsonLd(w){
    var old = document.getElementById("wd-jsonld");
    if (old) old.parentNode.removeChild(old);
    if (!w || !w.id) return;

    var origin = location.origin;
    var url = origin + "/#work/" + w.id;

    var cover = "";
    if (w.images && w.images.length) cover = imgPath(w.images[0], 0);
    else if (w.cover) cover = imgPath(w.cover, 0);
    if (cover && cover.indexOf("http") !== 0) cover = origin + (cover[0] === "/" ? "" : "/") + cover;

    var node = {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": url,
      "name": String(w.title || "作品"),
      "url": url,
      "inLanguage": "zh-CN",
      "author": { "@id": origin + "/#person" },
      "isPartOf": { "@id": origin + "/#website" }
    };
    if (w.desc) node.description = String(w.desc).slice(0, 500);
    if (cover) node.image = cover;
    if (w.tag) node.genre = String(w.tag);
    // 作品自带时间（"2026-10-02 03:33"）；ISO 8601 要求 T 分隔，
    // 且缺时区时会被当本地时间 —— 这里就是本地时间，符合实际。
    if (w.time) {
      var iso = String(w.time).replace(" ", "T");
      if (!isNaN(new Date(iso).getTime())) node.dateCreated = iso;
    }
    if (w.likes) {
      node.interactionStatistic = {
        "@type": "InteractionCounter",
        "interactionType": "https://schema.org/LikeAction",
        "userInteractionCount": Number(w.likes) || 0
      };
    }

    var s = document.createElement("script");
    s.type = "application/ld+json";
    s.id = "wd-jsonld";
    s.textContent = JSON.stringify(node);
    document.head.appendChild(s);
  }

  function renderWork(d){
    var w = d.item || {};
    var cmts = d.commentList || [];
    var prev = d.prev, next = d.next;

    injectWorkJsonLd(w);

    /* 相册：优先用 images[]，老数据只有 cover 时当成单张 */
    var imgs = [];
    if (w.images && w.images.length) imgs = w.images.slice();
    else if (w.cover) imgs = [w.cover];
    imgs = imgs.map(function(p, i){ return imgPath(p, i); });

    var files = w.files || [];
    var hasVideo = !!w.video;

    var navHtml = '<div class="wd-nav">';
    navHtml += prev
      ? '<a href="#work/' + prev.id + '">' + (prev.cover ? '<img src="' + esc(workImg(prev, 0)) + '" alt="上一件作品：' + esc(prev.title) + '">' : '<span class="ph">无图</span>') +
        '<span class="txt"><span class="d">上一件</span><span class="t">' + esc(prev.title) + '</span></span></a>'
      : '<span></span>';
    navHtml += next
      ? '<a class="nx" href="#work/' + next.id + '"><span class="txt"><span class="d">下一件</span><span class="t">' + esc(next.title) + '</span></span>' +
        (next.cover ? '<img src="' + esc(workImg(next, 0)) + '" alt="下一件作品：' + esc(next.title) + '">' : '<span class="ph">无图</span>') + '</a>'
      : '<span></span>';
    navHtml += '</div>';

    /* ── 主媒体区：有视频先给视频，否则给（第一张）大图 ── */
    var zoomSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/><path d="M11 8v6M8 11h6"/></svg>';
    var mediaInner;
    if (hasVideo){
      var vsrc = esc(mediaUrl(w.video));
      mediaInner =
        '<video class="wd-video" id="wd-video" controls preload="metadata" playsinline' +
          (imgs.length ? ' poster="' + esc(imgs[0]) + '"' : '') + '>' +
          '<source src="' + vsrc + '">' +
          '你的浏览器不支持内嵌播放，<a href="' + vsrc + '" target="_blank" rel="noopener">点这里打开视频</a>' +
        '</video>';
    } else if (imgs.length){
      // 渐进加载：详情页主图通常最大，最值得先给占位再淡入。
      // 注意**不加** loading="lazy" —— 这是首屏主角图，越早开始下载越好。
      // 包 <picture> 让它优先下 AVIF（详情页大图是 LCP 主角，最受益）。
      mediaInner =
        pictureHtml(imgs[0], 'alt="' + esc(w.title) + '" id="wd-img" decoding="async"') +
        '<span class="zoombadge">' + zoomSvg + '原图</span>';
    } else {
      // 纯文字作品（无视频、无图）：不塞渐变占位图 —— 那块图既难看又占地。
      // 改成把正文提到媒体区，让版面由文字撑开，视觉上也更像「文章」。
      mediaInner =
        '<div class="wd-textonly">' +
          '<div class="wt-k">' + (w.tag ? esc(w.tag) : '文字作品') + '</div>' +
          '<h2 class="wt-t">' + esc(w.title) + '</h2>' +
          (w.desc ? '<div class="wt-b">' + esc(w.desc) + '</div>' : '') +
        '</div>';
    }

    /* ── 相册缩略图条（多于一张才显示）── */
    var thumbsHtml = imgs.length > 1
      ? '<div class="wd-thumbs" id="wd-thumbs">' + imgs.map(function(p, i){
          return '<button type="button" data-i="' + i + '"' + (i === 0 ? ' class="on"' : '') +
            '><img src="' + esc(p) + '" alt="' + esc(w.title) + ' — 第 ' + (i + 1) + ' 张" loading="lazy"></button>';
        }).join("") + '</div>'
      : '';

    /* ── 附件下载 ── */
    var dlHtml = files.length
      ? '<div class="wd-dl"><h4>' + ICON_DL + ' 附件下载（' + files.length + '）</h4>' +
        files.map(function(f, i){
          var nm = f.name || String(f.path || "").split("/").pop();
          return '<a href="' + esc(dlUrl(w.id, i)) + '" download rel="noopener">' +
            '<span class="ic">' + esc(fileTag(nm)) + '</span>' +
            '<span class="nm" title="' + esc(nm) + '">' + esc(nm) + '</span>' +
            '<span class="sz">' + esc(f.sizeText || fmtSize(f.size)) + '</span>' +
            '<span class="ar">↓</span></a>';
        }).join("") + '</div>'
      : '';

    // 纯文字作品：标题与正文已经提到左侧媒体区展示了，
    // 右侧不再重复一遍（否则同一段文字页面上出现两次，很怪）。
    var textOnly = !hasVideo && !imgs.length;

    wdRoot.innerHTML =
      '<div class="wd-layout">' +
        '<div class="wd-media' + (hasVideo ? ' has-video' : '') + '" id="wd-media">' + mediaInner + '</div>' +
        '<div class="wd-side">' +
          (textOnly ? '' :
            '<div class="wd-kicker">' + (w.tag ? esc(w.tag) : "Work") + '</div>' +
            '<h2 class="wd-title">' + esc(w.title) + '</h2>') +
          '<div class="wd-meta">' +
            (w.time ? '<span class="gitem-x"><span class="loc">' + geoIcon() + esc(w.time) + '</span></span>' : '') +
          '</div>' +
          (textOnly ? '' : (w.desc ? '<div class="wd-desc">' + esc(w.desc) + '</div>' : '')) +
          '<div class="wd-act">' +
            '<button class="wd-like" id="wd-like" data-like="' + w.id + '">' +
              ICON_HEART + '<span id="wd-like-n">' + (w.likes || 0) + '</span> 点赞</button>' +
            '<button class="wd-share" id="wd-share" data-share="' + w.id + '" title="分享这件作品">' +
              ICON_SHARE + '<span>分享</span></button>' +
            (w.link ? '<a class="btn ghost" href="' + esc(w.link) + '" target="_blank" rel="noopener">查看原链接 ↗</a>' : '') +
          '</div>' +
          '<div class="wd-stats">' +
            '<div class="wd-stat"><span class="v" id="wd-s-like">' + (w.likes || 0) + '</span><span class="k">点赞</span></div>' +
            '<div class="wd-stat"><span class="v" id="wd-s-cmt">' + cmts.length + '</span><span class="k">评论</span></div>' +
            (imgs.length ? '<div class="wd-stat"><span class="v">' + imgs.length + '</span><span class="k">图片</span></div>' : '') +
            (files.length ? '<div class="wd-stat"><span class="v">' + files.length + '</span><span class="k">附件</span></div>' : '') +
          '</div>' +
          thumbsHtml +
          dlHtml +
          navHtml +
        '</div>' +
      '</div>' +

      /* ── 评论区：公开可见，谁都能看 ── */
      '<div class="wdc">' +
        '<div class="wdc-hd">' +
          '<h3>评论区</h3>' +
          '<span class="c" id="wdc-count">' + (cmts.length ? cmts.length + " 条评论" : "还没有人评论") + '</span>' +
        '</div>' +
        '<div class="wdc-form">' +
          '<div class="row"><input id="wdc-name" type="text" maxlength="24" placeholder="你的名字"></div>' +
          '<textarea id="wdc-text" rows="3" maxlength="800" placeholder="说点什么…（会显示你的大致归属地）"></textarea>' +
          '<div class="ft">' +
            '<button class="btn primary sm" id="wdc-send">发表评论</button>' +
            '<span class="msg" id="wdc-msg"></span>' +
          '</div>' +
        '</div>' +
        '<div class="wdc-list" id="wdc-list"></div>' +
      '</div>';

    // 名字记在本地，下次不用重填
    try {
      var saved = localStorage.getItem("zfsn_cmt_name");
      if (saved) $("#wdc-name").value = saved;
    } catch (e) {}

    // 大图 → 灯箱看原图
    var imgEl = $("#wd-img");
    if (imgEl) {
      // 回填真实宽高：浏览器据此在图片解码前就预留正确高度的空间，
      // 避免「图片加载完 → 下方内容被顶下去」（CLS 布局偏移）。
      // 作品大图宽高比不固定（用户上传），所以只能读出来再写回属性，
      // CSS 侧配 height:auto 生效。
      fillNaturalSize(imgEl);
      // 渐进加载。⚠ 用 imgs[0] 而不是 imgEl.src —— 此刻 src 还是
      // data: 占位图，真图是异步换上去的。灯箱必须拿真实路径，
      // 否则用户在图片加载完成前点开，看到的会是那张渐变占位图。
      blurUp(imgEl, imgs.length ? imgs[0] : placeholder(0), 0);
      imgEl.addEventListener("click", function(){
        var cur = Number(imgEl.getAttribute("data-cur") || 0);
        openLB(imgs.length ? (imgs[cur] || imgs[0]) : placeholder(0), w.title);
      });
    }

    // 相册缩略图：切主图；若作品带视频，则切换视频封面
    var tbox = $("#wd-thumbs");
    if (tbox){
      tbox.addEventListener("click", function(e){
        var b = e.target.closest("button[data-i]");
        if (!b) return;
        var i = Number(b.getAttribute("data-i"));
        tbox.querySelectorAll("button").forEach(function(x){ x.classList.remove("on"); });
        b.classList.add("on");
        var v = $("#wd-video");
        if (v && imgs[i]) v.setAttribute("poster", imgs[i]);
        var im = $("#wd-img");
        if (im && imgs[i]) {
          // 换图后宽高比可能变，先清掉旧尺寸再重新回填，
          // 否则占位高度会沿用上一张的，切换瞬间仍会跳一下
          im.removeAttribute("width");
          im.removeAttribute("height");
          // 记录当前是第几张 —— 灯箱点击时要拿它取正确的原图路径
          im.setAttribute("data-cur", String(i));
          // 换图也走渐进加载：相册里其他图可能还没下过
          blurUp(im, imgs[i], i);
          fillNaturalSize(im);
        }
      });
    }

    // 点赞
    var lk = $("#wd-like");
    if (lk) {
      lk.classList.toggle("on", !!d.liked);
      lk.addEventListener("click", function(){ doLike(w.id, lk); });
    }

    // 分享
    var sh = $("#wd-share");
    if (sh) sh.addEventListener("click", function(){ shareWork(w, sh); });

    // 发表评论
    $("#wdc-send").addEventListener("click", function(){ sendWorkComment(w.id); });
    var ta = $("#wdc-text");
    if (ta) ta.addEventListener("keydown", function(e){
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendWorkComment(w.id);
    });

    renderWorkComments(cmts);
  }

  function renderWorkComments(list){
    var box = $("#wdc-list");
    if (!box) return;
    if (!list.length){
      box.innerHTML = '<div class="wdc-empty">还没有评论 — 来抢第一个沙发</div>';
      return;
    }
    box.innerHTML = list.slice().sort(function(a, b){ return b.ts - a.ts; })
      .map(function(c, i){
        var initial = (c.name || "?").slice(0, 1).toUpperCase();
        var rg = (c.geo && c.geo.region) || "";
        return '<div class="wdc-item">' +
          '<header>' +
            '<span class="av">' + esc(initial) + '</span>' +
            '<span class="nm">' + esc(c.name) + '</span>' +
            (rg ? '<span class="rg">' + geoIcon() + esc(rg) + '</span>' : '') +
            '<span class="no">#' + (list.length - i) + '</span>' +
            '<span class="tm">' + esc(c.time || "") + '</span>' +
          '</header>' +
          '<div class="bd">' + esc(c.text) + '</div>' +
        '</div>';
      }).join("");
  }

  function sendWorkComment(workId){
    var nameEl = $("#wdc-name"), textEl = $("#wdc-text"), msg = $("#wdc-msg");
    var name = (nameEl.value || "").trim();
    var text = (textEl.value || "").trim();
    if (!name){ msg.textContent = "请填写名字"; msg.className = "msg err"; return; }
    if (!text){ msg.textContent = "请填写评论内容"; msg.className = "msg err"; return; }

    $("#wdc-send").disabled = true;
    msg.textContent = "发表中…"; msg.className = "msg";

    api("/api/works/" + workId + "/comments", {
      method: "POST", body: JSON.stringify({ name: name, text: text })
    }).then(function(){
      $("#wdc-send").disabled = false;
      try { localStorage.setItem("zfsn_cmt_name", name); } catch (e) {}
      msg.textContent = "已发表 ✓"; msg.className = "msg ok";
      textEl.value = "";
      // 重新拉详情，评论列表和计数一起刷新
      loadWork(workId);
      refreshCounts();
      setTimeout(function(){ if (msg.className.indexOf("ok") >= 0) msg.textContent = ""; }, 2400);
    }).catch(function(e){
      $("#wdc-send").disabled = false;
      msg.textContent = e.message || "发表失败";
      msg.className = "msg err";
    });
  }

  $("#wd-back").addEventListener("click", function(){
    try { location.hash = "works"; } catch (e) { go("works"); }
  });

  /* Lightbox */
  var lb = $("#lb"), lbImg = lb.querySelector("img"), lbCap = lb.querySelector(".cap");
  function openLB(src, cap){
    lbImg.src = src; lbImg.alt = cap ? (cap + " 大图") : "作品大图预览";
    lbCap.textContent = cap || "";
    lb.classList.add("on"); document.body.classList.add("locked");
  }
  function closeLB(){
    lb.classList.remove("on"); document.body.classList.remove("locked");
  }
  lb.addEventListener("click", function(e){ if (e.target !== lbImg) closeLB(); });
  lb.querySelector(".close").addEventListener("click", closeLB);
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeLB(); });

  /* ═══ Steam 数据 ═══ */
  var sgrid = $("#sgrid"), scount = $("#steam-count");
  var statsBox = $("#stats"), rblock = $("#recent-block"), rgrid = $("#rgrid");
  var sbar = $("#sbar"), ssearch = $("#ssearch"), ssort = $("#ssort");
  var sfilterCount = $("#sfilter-count");
  var morewrap = $("#morewrap"), morebtn = $("#morebtn"), moretxt = $("#moretxt");

  var FALLBACK = {
    count: 2, total_hours: 0,
    player: { name: "ZFSN114514" },
    games: [
      { appid: 438100, name: "VRChat", playtime: "\u2014", hours: 0, cover: coverUrl(438100) },
      { appid: 730, name: "Counter-Strike 2", playtime: "\u2014", hours: 0, cover: coverUrl(730) }
    ],
    recent: []
  };

  function coverUrl(appid){
    return "https://cdn.cloudflare.steamstatic.com/steam/apps/" + appid + "/header.jpg";
  }

  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ── 全量游戏状态 ── */
  var ALL_GAMES = [];      // 按时长降序的原始完整列表
  var VIEW_GAMES = [];     // 当前筛选/排序后的列表
  var SHOWN = 0;           // 已渲染条数
  var BATCH = 36;          // 每批渲染条数（懒加载，避免 165 张图一次性加载）
  var sortMode = "hours";
  var maxHours = 1;
  var searchTerm = "";

  /* 时长（分钟）排序用；未玩过排最后 */
  function byHours(a, b){
    var d = (b.hours || 0) - (a.hours || 0);
    if (d !== 0) return d;
    return String(a.name).localeCompare(String(b.name));
  }
  function byName(a, b){
    return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
  }

  /* 构建一张游戏卡片的 DOM */
  function makeCard(g){
    var idx = ALL_GAMES.indexOf(g);
    var a = document.createElement("a");
    a.className = "sgame" + (g.family ? " famcard" : "");
    a.href = g.store || ("https://store.steampowered.com/app/" + g.appid + "/");
    a.target = "_blank"; a.rel = "noopener";

    var pct = Math.max(3, Math.round(((g.hours || 0) / maxHours) * 100));
    var pt = (g.hours > 0)
      ? '<div class="pt"><span>' + esc(g.playtime) + '</span>' +
        '<span class="bar"><i style="width:' + pct + '%"></i></span></div>'
      : '<div class="pt"><span>' + esc(g.playtime || "未玩过") + '</span>' +
        '<span class="bar"><i style="width:3%;opacity:.35"></i></span></div>';

    // 家庭共享的游戏跟自己拥有的一起排在同一个网格里，
    // 只多一个右上角角标标明来源（不单独成区）。
    a.innerHTML =
      '<div class="cover">' +
        '<img src="' + esc(g.cover || coverUrl(g.appid)) + '" alt="' + esc(g.name) + ' 的游戏封面" loading="lazy" ' +
        'onerror="this.style.visibility=\'hidden\'">' +
        '<span class="rank">#' + (idx >= 0 ? idx + 1 : "—") + '</span>' +
        (g.family ? '<span class="fam" title="来自 Steam 家庭共享（不是自己购买的）">家庭</span>' : '') +
      '</div>' +
      '<div class="meta"><div class="nt" title="' + esc(g.name) + '">' + esc(g.name) + '</div>' +
      pt + '</div>';
    return a;
  }

  /* 分批追加渲染 */
  function appendBatch(){
    var end = Math.min(SHOWN + BATCH, VIEW_GAMES.length);
    if (SHOWN >= VIEW_GAMES.length) return;
    var frag = document.createDocumentFragment();
    for (var i = SHOWN; i < end; i++) frag.appendChild(makeCard(VIEW_GAMES[i]));
    sgrid.appendChild(frag);
    SHOWN = end;
    updateMore();
  }

  function updateMore(){
    var left = VIEW_GAMES.length - SHOWN;
    if (VIEW_GAMES.length === 0){
      morewrap.style.display = "none";
      return;
    }
    if (left > 0){
      morewrap.style.display = "block";
      morebtn.textContent = "加载更多（还有 " + left + " 款）";
      moretxt.textContent = "已显示 " + SHOWN + " / " + VIEW_GAMES.length + " 款";
    } else {
      morewrap.style.display = "block";
      morebtn.style.display = "none";
      moretxt.textContent = "已显示全部 " + VIEW_GAMES.length + " 款游戏";
    }
  }

  /* 应用搜索 + 排序，重置渲染 */
  function applyFilter(){
    var t = searchTerm.trim().toLowerCase();
    var list = !t ? ALL_GAMES.slice()
      : ALL_GAMES.filter(function(g){
          return String(g.name).toLowerCase().indexOf(t) >= 0 ||
                 String(g.appid).indexOf(t) >= 0;
        });
    list.sort(sortMode === "name" ? byName : byHours);
    VIEW_GAMES = list;

    sgrid.innerHTML = "";
    SHOWN = 0;
    if (!list.length){
      sgrid.innerHTML = '<div class="sempty">没有匹配「' + esc(searchTerm) + '」的游戏</div>';
      morewrap.style.display = "none";
      sfilterCount.textContent = "0 款";
      return;
    }
    sfilterCount.textContent = list.length + " 款" +
      (list.length !== ALL_GAMES.length ? " / 共 " + ALL_GAMES.length : "");
    appendBatch();
  }

  /* 首次渲染整体 */
  function renderGames(list){
    ALL_GAMES = list.slice().sort(byHours);
    maxHours = 1;
    ALL_GAMES.forEach(function(g){ if (g.hours > maxHours) maxHours = g.hours; });
    sbar.style.display = "flex";
    morebtn.style.display = "";
    applyFilter();
  }

  /* 交互绑定（只绑一次） */
  (function bindSteamUI(){
    var timer = null;
    ssearch.addEventListener("input", function(){
      clearTimeout(timer);
      timer = setTimeout(function(){
        searchTerm = ssearch.value;
        applyFilter();
      }, 180);
    });
    ssort.addEventListener("click", function(e){
      var b = e.target.closest ? e.target.closest("button[data-sort]") : null;
      if (!b) return;
      var m = b.getAttribute("data-sort");
      if (m === sortMode) return;
      sortMode = m;
      Array.prototype.forEach.call(ssort.children, function(x){ x.classList.toggle("on", x === b); });
      applyFilter();
    });
    morebtn.addEventListener("click", appendBatch);
  })();

  /* 渲染最近两周 */
  function renderRecent(list){
    if (!list || !list.length) return;
    rblock.style.display = "block";
    rgrid.innerHTML = "";
    list.forEach(function(g, i){
      var a = document.createElement("a");
      a.className = "rcard reveal";
      a.style.animationDelay = (i * .06) + "s";
      a.href = "https://store.steampowered.com/app/" + g.appid + "/";
      a.target = "_blank"; a.rel = "noopener";
      a.innerHTML =
        '<img src="' + esc(g.cover || coverUrl(g.appid)) + '" alt="' + esc(g.name) + ' 的游戏封面" loading="lazy" ' +
        'onerror="this.style.visibility=\'hidden\'">' +
        '<div class="rm"><div class="rn" title="' + esc(g.name) + '">' + esc(g.name) + '</div>' +
        '<div class="rt">' + esc(g.playtime2w || "") + '</div></div>';
      rgrid.appendChild(a);
    });
  }

  /* 渲染统计条 */
  function renderStats(d){
    var games = d.games || [];
    if (!games.length) return;
    statsBox.style.display = "grid";
    var sorted = games.slice().sort(byHours);
    $("#st-games").textContent = (d.count || games.length);
    $("#st-hours").textContent = d.total_hours ? (d.total_hours.toLocaleString() + " h") : "—";
    $("#st-top").textContent = sorted[0] ? sorted[0].name : "—";
    $("#st-top").style.fontSize = "";
    var created = d.player && d.player.created ? String(d.player.created).slice(0, 4) : "";
    $("#st-since").textContent = created || "—";
    if (d.player && d.player.name){
      $("#steam-persona").textContent = d.player.name;
    }
  }

  /* ═══ Steam 家庭共享游戏（合并进主列表）═══
     数据来自 tools/build_steam_family.py → steam_family.json：
       ① 本机 <Steam>/userdata/<id>/config/localconfig.vdf 的 FamilyGroup → 成员名单
       ② 逐个成员查 GetOwnedGames 取并集
       ③ 减去 steam_games.json 里「自己拥有」的 → 家庭共享游戏

     为什么单独一个文件而不是直接写进 steam_games.json：
       两个抓取脚本就能互不依赖。API Key 失效时 build_steam_owned.py 会失败，
       但家庭共享那份仍能刷新（反过来也一样），不会互相拖累。

     ⚠ 展示上**不单独成区** —— 直接并进"全部游戏"，
       只挂一个右上角「家庭」角标标明来源。
     ─────────────────────────────────────────────── */
  function loadFamily(){
    return fetch("steam_family.json")
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(d){ return (d && d.games && d.games.length) ? d : null; })
      .catch(function(){ return null; });   // 没有这个文件就当作没有家庭共享
  }

  /* 把家庭共享游戏并进自己拥有的列表 */
  function mergeFamily(owned, famDoc){
    var list = (owned || []).slice();
    var seen = {};
    list.forEach(function(g){ seen[g.appid] = 1; });
    var added = 0;
    ((famDoc && famDoc.games) || []).forEach(function(g){
      if (seen[g.appid]) return;      // 两边都有就保留自己那条（时长更准）
      seen[g.appid] = 1;
      g.family = true;
      list.push(g);
      added++;
    });
    return { games: list, familyCount: added };
  }

  function sumHours(list){
    var h = 0;
    list.forEach(function(g){ h += (g.hours || 0); });
    return Math.round(h * 10) / 10;
  }

  /* 一次性渲染合并后的完整游戏库 */
  function applySteam(owned, famDoc){
    var m = mergeFamily(owned.games, famDoc);
    var games = m.games;
    var totalHours = sumHours(games);

    renderGames(games);
    renderStats({
      count: games.length,
      total_hours: totalHours,
      games: games,
      player: owned.player
    });
    renderRecent(owned.recent);

    scount.textContent = "共 " + games.length + " 款游戏" +
      (totalHours ? " · " + totalHours.toLocaleString() + " 小时总时长" : "") +
      (m.familyCount ? " · 其中 " + m.familyCount + " 款来自家庭共享" : "");

    // ── 首页 Steam 概览卡 ──
    var hvs = $("#hs-steam-v"), hss = $("#hs-steam-s");
    if (hvs) hvs.textContent = games.length + " 款游戏";
    if (hss) hss.textContent = totalHours
      ? totalHours.toLocaleString() + " 小时总时长"
      : "暂无时长数据";
  }

  fetch("steam_games.json")
    .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(d){
      var data = (d && d.games && d.games.length) ? d : FALLBACK;
      // 家庭共享是可选增量：拿不到就只显示自己拥有的
      return loadFamily().then(function(famDoc){ applySteam(data, famDoc); });
    })
    .catch(function(){
      // 只有连"自己拥有"都读不到才会走到这里
      renderGames(FALLBACK.games);
      renderStats(FALLBACK);
      scount.textContent = "\u964d\u7ea7\u6570\u636e";
    });

  /* ═══ B站数据 ═══
     数据结构（由 tools/build_bili.py 生成）：
       profile: { name, face_local, face, sign, level, followers, following,
                  likes, total_views, total_likes, total_coins, ... }
       videos:  [ { bvid, title, cover, pub, length, tname, desc,
                    views, danmaku, reply, like, coin, favorite, share } ]
     ─────────────────────────────────────────────── */
  var vgrid = $("#vgrid"), bcount = $("#bili-count");
  var bprofile = $("#bprofile"), bstats = $("#b-stats");
  var btools = $("#btools"), bsortBox = $("#bsort"), bsearch = $("#bsearch"), bcnt = $("#bcnt");

  var VID_ALL = [];        // 全量
  var VID_VIEW = [];       // 过滤+排序后
  var vShown = 0, V_BATCH = 24, vidSort = "new", vidQuery = "";

  var VFALLBACK = [
    { bvid: "", title: "前往 B站 主页查看最新投稿", cover: "", pub: "", views: 0 }
  ];

  function fmtN(n){
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(2).replace(/\.?0+$/, "") + "亿";
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.?0+$/, "") + "万";
    return String(n);
  }

  function renderProfile(p, list){
    if (!p || (!p.name && !p.followers)) return;
    bprofile.style.display = "";

    // 头像：优先用本地已下载的（B站 CDN 有防盗链，外链可能加载不出来）
    var av = $("#b-avatar");
    var name = p.name || "ZFSN";
    av.alt = name + " 的哔哩哔哩头像";
    var src = p.face_local || p.face || "";
    if (src){
      av.src = src;
      av.style.display = "";
      av.classList.remove("ph");
    } else {
      // 没有头像时用昵称首字做圆形占位：
      // img 无法显示文字，所以把它变成纯色圆底 + 伪元素首字
      av.removeAttribute("src");
      av.classList.add("ph");
      av.style.display = "";
      av.setAttribute("data-initial", name.slice(0, 1).toUpperCase());
    }
    $("#b-name").textContent = name;
    $("#b-level").textContent = "Lv" + (p.level || 0);
    $("#b-sign").textContent = p.sign || "";

    // ── 首页 B站 概览卡 ──
    var hvb = $("#hs-bili-v"), hsb = $("#hs-bili-s");
    if (hvb) hvb.textContent = fmtN(p.followers) + " 粉丝";
    if (hsb) hsb.textContent = fmtN(p.total_views != null ? p.total_views
      : list.reduce(function(a, x){ return a + (Number(x.views) || 0); }, 0)) + " 总播放" +
      (list.length ? " · " + list.length + " 个投稿" : "");

    var cells = [
      { v: fmtN(p.followers), k: "粉丝" },
      { v: fmtN(p.following), k: "关注" },
      { v: fmtN(p.total_views != null ? p.total_views : list.reduce(function(a, x){ return a + (Number(x.views) || 0); }, 0)), k: "总播放" },
      { v: fmtN(p.likes), k: "获赞" },
      { v: fmtN(list.reduce(function(a, x){ return a + (Number(x.coin) || 0); }, 0)), k: "投币" },
      { v: fmtN(list.reduce(function(a, x){ return a + (Number(x.favorite) || 0); }, 0)), k: "收藏" }
    ];
    bstats.innerHTML = cells.map(function(c){
      return '<div class="bstat"><div class="bv">' + esc(c.v) + '</div>' +
             '<div class="bk">' + esc(c.k) + '</div></div>';
    }).join("");
  }

  function makeVCard(v, i){
    var a = document.createElement("a");
    a.className = "vcard reveal";
    a.style.animationDelay = (i * .04) + "s";
    a.href = v.bvid ? ("https://www.bilibili.com/video/" + v.bvid)
                    : "https://space.bilibili.com/1220210222";
    a.target = "_blank"; a.rel = "noopener";

    var thumb = v.cover
      ? '<img src="' + esc(v.cover) + '" alt="' + esc(v.title || "B站视频") + ' 的视频封面" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(0,174,236,.18),rgba(4,4,8,1));font-size:11px;letter-spacing:.2em;color:#5a6a78;text-transform:uppercase">bilibili</div>';

    // 时长角标
    var dur = v.length ? '<span class="vdur">' + esc(v.length) + '</span>' : '';

    // 分区标签
    var tagsHtml = "";
    if (v.tname){
      tagsHtml = '<div class="vtags"><span class="vtag">' + esc(v.tname) + '</span></div>';
    }

    // 互动数据（只在有值时显示）
    var st = [];
    if (Number(v.views)) st.push('<span>播放 <b>' + fmtN(v.views) + '</b></span>');
    if (Number(v.like)) st.push('<span>赞 <b>' + fmtN(v.like) + '</b></span>');
    if (Number(v.coin)) st.push('<span>币 <b>' + fmtN(v.coin) + '</b></span>');
    if (Number(v.favorite)) st.push('<span>藏 <b>' + fmtN(v.favorite) + '</b></span>');
    if (Number(v.danmaku)) st.push('<span>弹幕 <b>' + fmtN(v.danmaku) + '</b></span>');
    if (Number(v.reply)) st.push('<span>评论 <b>' + fmtN(v.reply) + '</b></span>');
    var statsHtml = st.length ? '<div class="vstats">' + st.join("") + '</div>' : '';

    var meta = [];
    if (v.pub) meta.push('<span>' + esc(v.pub) + '</span>');
    if (v.pages && Number(v.pages) > 1) meta.push('<span>' + Number(v.pages) + 'P</span>');

    a.innerHTML =
      '<div class="thumb">' + thumb + dur + '<div class="play"><span>▶</span></div></div>' +
      '<div class="meta">' +
        '<div class="vt">' + esc(v.title) + '</div>' +
        (meta.length ? '<div class="vs">' + meta.join("") + '</div>' : '') +
        tagsHtml + statsHtml +
      '</div>';
    return a;
  }

  function appendVideos(){
    if (vShown >= VID_VIEW.length) return;
    var end = Math.min(vShown + V_BATCH, VID_VIEW.length);
    var frag = document.createDocumentFragment();
    for (var i = vShown; i < end; i++) frag.appendChild(makeVCard(VID_VIEW[i], i));
    vgrid.appendChild(frag);
    vShown = end;
  }

  function applyVFilter(){
    var q = vidQuery.trim().toLowerCase();
    var arr = VID_ALL.filter(function(v){
      if (!q) return true;
      return (v.title || "").toLowerCase().indexOf(q) >= 0 ||
             (v.tname || "").toLowerCase().indexOf(q) >= 0 ||
             (v.desc || "").toLowerCase().indexOf(q) >= 0;
    });

    arr.sort(function(a, b){
      switch (vidSort){
        case "views": return (Number(b.views) || 0) - (Number(a.views) || 0);
        case "like":  return (Number(b.like) || 0) - (Number(a.like) || 0);
        case "dur":   return (Number(b.duration) || 0) - (Number(a.duration) || 0);
        default:      return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      }
    });

    VID_VIEW = arr;
    vgrid.innerHTML = "";
    vShown = 0;

    if (!arr.length){
      vgrid.innerHTML = '<div class="sempty" style="grid-column:1/-1"><span class="ic">◌</span>' +
        '<div class="t">没有匹配的视频</div></div>';
      if (bcnt) bcnt.textContent = "0 / " + VID_ALL.length;
      return;
    }
    appendVideos();
    if (bcnt) bcnt.textContent = arr.length + (q || vidSort !== "new" ? (" / " + VID_ALL.length) : "") + " 条";
  }

  function renderVideos(list){
    VID_ALL = list;
    if (btools) btools.style.display = "";
    applyVFilter();
  }

  // 触底加载更多
  if (vgrid){
    var vSentinel = document.createElement("div");
    vSentinel.style.cssText = "grid-column:1/-1;height:1px";
    vgrid.parentNode.appendChild(vSentinel);
    if ("IntersectionObserver" in window){
      new IntersectionObserver(function(es){
        es.forEach(function(e){
          if (e.isIntersecting && vShown < VID_VIEW.length){
            appendVideos();
            // 追加后重新观察（保持触发能力）
            vSentinel.scrollIntoView({ block: "nearest" });
          }
        });
      }, { rootMargin: "400px" }).observe(vSentinel);
    }
  }

  // 排序 / 搜索绑定
  if (bsortBox){
    bsortBox.addEventListener("click", function(e){
      var btn = e.target.closest("button[data-sort]");
      if (!btn) return;
      Array.prototype.forEach.call(bsortBox.children, function(b){ b.classList.remove("on"); });
      btn.classList.add("on");
      vidSort = btn.getAttribute("data-sort");
      applyVFilter();
    });
  }
  if (bsearch){
    var bTimer = null;
    bsearch.addEventListener("input", function(){
      clearTimeout(bTimer);
      bTimer = setTimeout(function(){
        vidQuery = bsearch.value || "";
        applyVFilter();
      }, 180);
    });
  }

  fetch("bili_videos.json")
    .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(d){
      var list = (d && d.videos && d.videos.length) ? d.videos : VFALLBACK;
      renderProfile(d && d.profile, list);
      renderVideos(list);
      if (bcount){
        var s = "UID " + (d.mid || 1220210222) + " · " + list.length + " 条投稿";
        if (d.updated) s += " · 更新于 " + d.updated.slice(0, 10);
        bcount.textContent = s;
      }
    })
    .catch(function(e){
      if (bcount) bcount.textContent = "数据加载失败，请稍后重试";
      renderVideos(VFALLBACK);
    });

  /* ═══ Xbox 数据 ═══ */
  var xgrid = $("#xgrid"), xcount = $("#xbox-count");
  var xstats = $("#xstats");
  var XFALLBACK = { count: 0, total_hours: 0, games: [] };

  function renderXbox(d){
    if (!xgrid) return;
    var games = (d && d.games) || [];

    if (!games.length){
      xgrid.innerHTML = '<div class="sempty">' +
        (d && d.note ? d.note : "Xbox 数据待补充") + '</div>';
      if (xcount) xcount.textContent = "Xbox Profile";
      return;
    }

    /* 头部统计：总时长 / 成就总数 / 最常玩 */
    var tot = 0, ach = 0, hasHour = [];
    games.forEach(function(g){
      var h = Number(g.hours);
      if (!isNaN(h) && h > 0){ tot += h; hasHour.push(g); }
      ach += (Number(g.achievements_done) || 0);
    });
    var best = hasHour.slice().sort(function(a, b){ return b.hours - a.hours; })[0];

    if (xcount){
      xcount.textContent = "共 " + (d.count || games.length) + " 款游戏" +
        (tot > 0 ? " · " + Math.round(tot).toLocaleString() + " 小时" : "");
    }
    // ── 首页 Xbox 概览卡 ──
    var hvx = $("#hs-xbox-v"), hsx = $("#hs-xbox-s");
    var xTotalAch = Number(d.total_achievements) || ach;
    if (hvx) hvx.textContent = (d.count || games.length) + " 款游戏";
    if (hsx) hsx.textContent = tot > 0
      ? Math.round(tot).toLocaleString() + " 小时" +
        (xTotalAch > 0 ? " · " + xTotalAch.toLocaleString() + " 成就" : "")
      : "暂无时长数据";
    if (xstats && tot > 0){
      xstats.style.display = "grid";
      $("#xt-games").textContent = (d.count || games.length);
      $("#xt-hours").textContent = Math.round(tot).toLocaleString() + " h";
      $("#xt-ach").textContent = ach > 0 ? ach.toLocaleString() : "—";
      $("#xt-top").textContent = best ? best.name : "—";
      $("#xt-top").style.fontSize = (best && best.name.length > 12) ? "15px" : "";
    }

    /* 按时长降序，无数据排最后 */
    var sorted = games.slice().sort(function(a, b){
      var ha = Number(a.hours), hb = Number(b.hours);
      return (isNaN(hb) ? -1 : hb) - (isNaN(ha) ? -1 : ha);
    });
    var maxH = 1;
    sorted.forEach(function(g){ if (g.hours > maxH) maxH = g.hours; });

    xgrid.innerHTML = "";
    sorted.forEach(function(g, i){
      var a = document.createElement("a");
      a.className = "xcard";
      a.href = g.store || "https://www.xbox.com/zh-CN/play/user/ZFSN114514";
      a.target = "_blank"; a.rel = "noopener";

      var h = Number(g.hours);
      var hasT = !isNaN(h) && h > 0;
      var pct = hasT ? Math.max(3, Math.round((h / maxH) * 100)) : 0;
      var achDone = Number(g.achievements_done) || 0;
      var achTot = Number(g.achievements_total) || 0;

      var poster = g.cover
        ? '<img src="' + esc(g.cover) + '" alt="' + esc(g.name) + ' 的游戏封面" loading="lazy" onerror="this.style.display=\'none\'">'
        : '<div class="xph">' + esc((g.name || "X").slice(0, 2)) + '</div>';

      a.innerHTML =
        '<div class="xposter">' + poster +
          '<span class="xrank">#' + (i + 1) + '</span>' +
          (achTot > 0 ? '<span class="xach">' + achDone + '/' + achTot + '</span>' : '') +
          '<div class="xmeta">' +
            '<div class="xn" title="' + esc(g.name) + '">' + esc(g.name) + '</div>' +
            (hasT
              ? '<div class="xh"><span class="t">' + esc(g.playtime || (h + "h")) + '</span>' +
                '<span class="bar"><i style="width:' + pct + '%"></i></span></div>'
              : '<div class="xh"><span class="t" style="color:#6a7a6a">暂无数据</span>' +
                '<span class="bar nodata"><i style="width:0"></i></span></div>') +
          '</div>' +
        '</div>';
      xgrid.appendChild(a);
    });
  }

  fetch("xbox_games.json")
    .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(renderXbox)
    .catch(function(){ renderXbox(XFALLBACK); });

  /* ═══ 留言板 ═══ */
  var glist = $("#glist"), gcount = $("#g-count"), gmine = $("#g-mine");
  var gmask = $("#gmask"), gname = $("#gmname"), gtext = $("#gmtext");
  var gmloc = $("#gmloc"), gmerr = $("#gmerr"), gsubmit = $("#gsubmit");
  var gmorewrap = $("#gmorewrap"), gmorebtn = $("#gmorebtn"), gmoretxt = $("#gmoretxt");

  var MSG_ALL = [];
  var MSG_SHOWN = 0;
  var G_BATCH = 12;
  var myGeo = null;

  /* ── 后端服务地址探测 ──────────────────────────────────
     页面可能通过多种方式打开，后端地址各不相同：
       · https://api.zfsnnb.dpdns.org → 隧道（**当前线上方案**）
       · http://localhost:3000        → 同源，最省事
       · http://域名:3000             → 同源（公网直连方案）
       · https://域名:3443            → 同源（本机自签名 HTTPS 方案）
       · http://localhost:88          → 同源不通，需跨到 :3000
       · http://192.168.x.x:88        → 同上，用当前主机名的 3000
       · file://                      → 只能写死 localhost:3000
     所以列出所有候选地址并发探测 /api/health，取**优先级最高的那个成功地址**。

     ★ 线上现状（2026-10 起）：
       静态页挂在 Cloudflare Workers（https://www.zfsnnb.dpdns.org），
       接口由家里的 Node 后端经 **Cloudflare 隧道** 暴露为
       https://api.zfsnnb.dpdns.org。两端都是 https，且证书由
       Cloudflare 签发（受信），所以既没有混合内容问题，
       访客也不会看到自签名证书的"不安全"警告。
       隧道请求路径：访客 → CF 边缘(LAX) → 家里 cloudflared → Node:3000，
       实测 TTFB ≈ 1.0s。

     ⚠ 四个必须避开的坑：
       1. 缓存污染 —— sessionStorage 里可能残留上次的地址（比如上次用
          localhost 打开、这次用公网域名），换个浏览器标签就失效。
          所以缓存命中后仍要复验，失败就重跑全量探测。
       2. 端口相同即同源 —— 判断"同源"要看 location.port，不能只看协议。
       3. 混合内容 —— https 页面请求 http 接口会被浏览器直接拦掉
          （请求根本发不出去，表现为接口静默失败）。所以候选地址的
          协议必须跟页面一致，不能"反正都试一遍"。
          例外：http://localhost 与 http://127.0.0.1 被浏览器视为
          可信来源，https 页面下也允许请求，所以可以保留。
       4. CF 只代理固定端口 —— 免费版 Cloudflare 只回源
          80/443/8080/8443/2052/2053/2082/2083/2086/2087/2095/2096。
          **:3443 不在名单里**，写 `https://域名:3443` 是连不上的
          （旧版本的提示文案就是踩了这个坑，已改）。
     ──────────────────────────────────────────────────── */
  var API_BASE = "";          // 探测完成前为空
  var API_READY = null;       // Promise
  var API_CACHE_KEY = "zfsn_api_base";

  /* Cloudflare 隧道暴露的后端地址。
     ★ 改隧道主机名时，这里要和 D:\ZFSN-server\cloudflared\config.yml 一起改。 */
  var TUNNEL_API = "https://api.zfsnnb.dpdns.org";

  /* 后端两个监听端口，需与 D:\ZFSN-server\server.js 保持一致
     （那边由 PORT / HTTPS_PORT 环境变量控制，默认 3000 / 3443） */
  var HTTP_API_PORT = 3000;
  var HTTPS_API_PORT = 3443;

  function portOf(loc){
    if (loc.port) return loc.port;
    return loc.protocol === "https:" ? "443" : "80";
  }

  function apiCandidates(){
    var list = [];
    var host = location.hostname;
    var proto = location.protocol;
    var isWeb = (proto === "http:" || proto === "https:");
    var isHttps = (proto === "https:");

    /* 页面是不是 Cloudflare 静态托管（Workers）？
       特征：主机名 www.zfsnnb.dpdns.org 且走默认 443。
       这种情况同源 /api/* 落在静态资源里 → 404，所以隧道必须排在同源前面，
       否则每次首屏都要先白探一轮。（apex 域名 zfsnnb.dpdns.org 的 DNS 没走
       Cloudflare，指向家里，不算 CF 托管；带上 :3443 时更是本地后端自己提供页面。） */
    var isCFHost = /^www\.zfsnnb\.dpdns\.org$/i.test(host || "") &&
                   (location.port === "" || location.port === "443");

    // ① 同源 —— **线上方案**。
    //    站点现在由 Cloudflare Worker 提供：页面和 /api/* 出自同一个服务，
    //    所以无条件排在最前，一次命中，不必再白探别的候选。
    //    （迁移之前 CF 只托管静态资源，同源 /api 必然 404，才需要特判跳过；
    //     现在 Worker 自带接口，那个例外可以去掉了。）
    if (isWeb) list.push("");

    // ② Cloudflare 隧道 —— 降级为**回退方案**。
    //    Worker 还没部署好、或者出故障时，家里那台机器上的旧后端
    //    （node server.js + cloudflared）还能顶上，前提是它开着。
    if (isHttps) list.push(TUNNEL_API);

    // ③（已并入 ①）CF 托管下的同源不再单独登记 —— Worker 自带 /api/*。

    // ④ 当前主机名的后端端口 —— 覆盖"页面在 443/IIS:88、后端在 3000/3443"的场景。
    //    协议必须跟页面一致（见上面第 3 条坑）。
    //    若页面端口本来就等于后端端口，说明 ① 的同源候选已经覆盖它，不必再探。
    //    ⚠ CF 托管下跳过：CF 免费版只代理 80/443/8080/8443 等固定端口，
    //      :3443 不在名单里，连接会一直挂到超时，纯属浪费。
    var samePort = isWeb && (portOf(location) === String(isHttps ? HTTPS_API_PORT : HTTP_API_PORT));
    if (host && !samePort && !isCFHost){
      list.push((isHttps ? "https://" : "http://") + host + ":" +
                (isHttps ? HTTPS_API_PORT : HTTP_API_PORT));
    }

    // ⑤ 本机兜底：页面在 file:// 时用得上。
    //    https 页面下 localhost 只能走 https（自签名证书需先手动信任一次），
    //    但 http://localhost 属于浏览器豁免的"可信来源"，仍然可用。
    if (isHttps){
      list.push("https://localhost:" + HTTPS_API_PORT);
      list.push("https://127.0.0.1:" + HTTPS_API_PORT);
    }
    list.push("http://localhost:" + HTTP_API_PORT);
    list.push("http://127.0.0.1:" + HTTP_API_PORT);

    // 去重，保持顺序
    var seen = {}, out = [];
    list.forEach(function(u){ if (!(u in seen)){ seen[u] = 1; out.push(u); } });
    return out;
  }

  function probe(base){
    return new Promise(function(resolve){
      var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      // ★ 超时给到 3500ms：走 Cloudflare 隧道时请求要绕到境外边缘再回到家里，
      //   实测 TTFB 约 1.0s（境外节点首连偶尔到 1.5s）。2200ms 余量太薄，
      //   网络稍差就会误判成"后端挂了"，然后白探一圈其他候选。
      //   代价只是：后端真挂了时用户多等 1.3s 才看到提示。
      var timer = setTimeout(function(){
        if (ctl) ctl.abort();
        resolve(null);
      }, 3500);
      // 同源请求会被浏览器/CDN 缓存，加时间戳绕过
      var url = (base || "") + "/api/health" + (base ? "" : "?_=" + Date.now());
      fetch(url, { signal: ctl ? ctl.signal : undefined, cache: "no-store" })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){
          clearTimeout(timer);
          resolve(d && d.ok ? (base || "") : null);
        })
        .catch(function(){ clearTimeout(timer); resolve(null); });
    });
  }

  function detectAPI(){
    if (API_READY) return API_READY;

    var cached = null;
    try { cached = sessionStorage.getItem(API_CACHE_KEY); } catch (e) {}

    // 缓存值必须仍在当前候选列表里才可信 —— 否则说明用户换了访问方式
    var bases = apiCandidates();
    var cacheValid = (cached !== null && bases.indexOf(cached) >= 0);

    /* 并发探测所有候选，但**不等全部返回**：
       一旦"优先级最高的那个成功候选"确定，就立刻收工。
       原因：候选里有走不通的地址（如 Cloudflare 不代理的 :3443，连接会一直挂到
       超时），若用 Promise.all 等全部返回，隧道明明 1s 就通了也要白等满 3.5s。
       规则：候选 i 成功时，只有排在它前面的候选都已落败，它才是最优解。 */
    function raceAll(list){
      return new Promise(function(resolve){
        var n = list.length;
        if (!n) return resolve(null);
        var res = new Array(n);          // undefined=未定论 / null=失败 / 字符串=成功
        var settledCount = 0;
        var done = false;

        function finish(v){
          if (done) return;
          done = true;
          if (v !== null){ try { sessionStorage.setItem(API_CACHE_KEY, v); } catch (e) {} }
          resolve(v);
        }
        // 从前往后扫：遇到未定论就返回 undefined（还得等），否则返回最优（或 null=全败）
        function bestSoFar(){
          for (var i = 0; i < n; i++){
            if (res[i] === undefined) return undefined;
            if (res[i] !== null) return res[i];
          }
          return null;
        }

        list.forEach(function(base, i){
          probe(base).then(function(v){
            if (done) return;
            res[i] = v;
            settledCount++;
            if (settledCount === n){ finish(bestSoFar()); return; }
            var b = bestSoFar();
            if (b !== undefined) finish(b);
          });
        });
      });
    }

    API_READY = cacheValid
      // 先复验缓存；失效就重跑全量
      ? probe(cached).then(function(ok){
          return (ok !== null) ? ok : raceAll(bases);
        })
      : raceAll(bases);

    // 探测完成后刷新对应 UI
    API_READY.then(function(base){
      API_BASE = (base === null) ? null : (base || "");
      if (window.__zfsnOnAPIReady) window.__zfsnOnAPIReady(base);
      // 作品墙依赖后端数据，等地址确定后再加载
      if (window.__zfsnLoadGallery) window.__zfsnLoadGallery();
    });

    return API_READY;
  }

  /* 统一请求：先确保后端地址已探测出来 */
  function api(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    return detectAPI().then(function(base){
      if (base === null){
        throw new Error("后端服务未启动（请在 D:\\ZFSN-server 运行 node server.js）");
      }
      return fetch(base + path, opts);
    }).then(function(r){
      return r.json().catch(function(){ throw new Error("服务返回异常 (HTTP " + r.status + ")"); })
        .then(function(d){
          if (!r.ok || d.ok === false) throw new Error(d.error || ("HTTP " + r.status));
          return d;
        });
    });
  }

  function geoIcon(){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  }

  /** 后端相对路径 → 完整 URL。
   * 留言/作品图都存相对路径（"/api/media/messages/abc/0.jpg"），
   * 在同源（API_BASE=""）和隧道（API_BASE="https://api..."）下都需要拼前缀。
   * 调用点（makeMsgItem）只在 detectAPI() 解决之后才跑，所以 API_BASE 已就绪。 */
  function mediaUrl(rel){
    return (API_BASE || "") + rel;
  }

  function makeMsgItem(m){
    var d = document.createElement("div");
    d.className = "gitem";
    var initial = (m.name || "?").slice(0, 1).toUpperCase();
    var loc = (m.geo && m.geo.region) || "";
    var imgs = Array.isArray(m.images) ? m.images : [];
    var voices = Array.isArray(m.voices) ? m.voices : [];

    var attachHtml = "";
    if (imgs.length){
      attachHtml += '<div class="msg-imgs">' + imgs.map(function(u, i){
        return '<img src="' + mediaUrl(u) + '" alt="留言附带的图片 ' + (i + 1) + '" loading="lazy" referrerpolicy="no-referrer">';
      }).join("") + '</div>';
    }
    if (voices.length){
      attachHtml += voices.map(function(v){
        var dur = v && v.duration ? Math.round(v.duration) : 0;
        return '<div class="msg-voice">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>' +
          '<audio src="' + mediaUrl(v.url) + '" controls preload="none"></audio>' +
          (dur ? '<b>' + dur + 's</b>' : '') +
        '</div>';
      }).join("");
    }

    d.innerHTML =
      '<header>' +
        '<span class="av">' + esc(initial) + '</span>' +
        '<span class="who">' + esc(m.name) + '</span>' +
        (loc ? '<span class="loc">' + geoIcon() + esc(loc) + '</span>' : '') +
        '<span class="when">' + esc(m.time || "") + '</span>' +
      '</header>' +
      '<div class="body">' + esc(m.text) + '</div>' +
      attachHtml;

    // 正文超过 6 行会被 CSS 折叠，点一下展开看全文。
    // 只给"真的被截断"的加交互，短留言点了没反应反而奇怪。
    var body = d.querySelector(".body");
    if (body && body.scrollHeight > body.clientHeight + 4){
      d.classList.add("clamped");
      d.addEventListener("click", function(){
        d.classList.toggle("open");
      });
    }
    return d;
  }

  function gAppendBatch(){
    if (MSG_SHOWN >= MSG_ALL.length) return;
    var end = Math.min(MSG_SHOWN + G_BATCH, MSG_ALL.length);
    var frag = document.createDocumentFragment();
    for (var i = MSG_SHOWN; i < end; i++) frag.appendChild(makeMsgItem(MSG_ALL[i]));
    glist.appendChild(frag);
    MSG_SHOWN = end;
    gUpdateMore();
  }

  function gUpdateMore(){
    var left = MSG_ALL.length - MSG_SHOWN;
    if (left > 0){
      gmorewrap.style.display = "block";
      gmorebtn.textContent = "加载更多（还有 " + left + " 条）";
      gmoretxt.textContent = "已显示 " + MSG_SHOWN + " / " + MSG_ALL.length + " 条";
    } else {
      gmorewrap.style.display = "block";
      gmorebtn.style.display = "none";
      gmoretxt.textContent = MSG_ALL.length ? ("已显示全部 " + MSG_ALL.length + " 条留言") : "还没有留言，来抢第一条吧";
    }
  }

  function renderMessages(list){
    MSG_ALL = (list || []).slice();
    MSG_SHOWN = 0;
    glist.innerHTML = "";
    if (!MSG_ALL.length){
      glist.innerHTML = '<div class="gempty"><span class="ic">◇</span><div class="t">还没有人留言 — 写下第一条吧</div></div>';
      gUpdateMore();
      return;
    }
    gAppendBatch();
  }

  /* 后端连不上时给出可操作的排查指引。
     要点：区分"访问者是不是本机"——本机多半是服务没启动，
     外部访客则多半是端口没映射到公网，两者的解法完全不同。 */
  function backendHelp(){
    var lines = [];
    var proto = location.protocol;
    var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname || "");

    if (proto === "https:"){
      // ★ 线上方案：页面在 Cloudflare（Workers 静态资源），后端经 Cloudflare
      //   隧道暴露为 https://api.zfsnnb.dpdns.org。两端都是 https 且证书受信，
      //   正常情况下不会再有"混合内容"问题。
      //   ⚠ 不要再建议用户去访问 https://域名:3443 —— Cloudflare 免费版只代理
      //     80/443/8080/8443 等固定端口，3443 不在名单里，走不通。
      if (/zfsnnb\.dpdns\.org$/i.test(location.hostname || "")){
        lines.push('本站后端由 <b style="color:#cfe3f5">Cloudflare 隧道</b> ' +
          '（<code style="color:#cfe3f5">' + TUNNEL_API + '</code>）提供。');
        lines.push('如果你是站主：多半是家里那台机器上的 <code style="color:#ff8a9c">cloudflared</code> ' +
          '没在跑，或 Node 后端（:3000）没启动。');
        lines.push('排查：任务计划程序里看 <code style="color:#ff8a9c">ZFSN-Cloudflare-Tunnel</code> ' +
          '是否在运行；再确认 <code style="color:#ff8a9c">D:\\ZFSN-server\\启动服务.bat</code> 已执行。');
      } else {
        lines.push('当前页面是 <b style="color:#ff8a9c">https</b> 协议。' +
          '如果后端只开了 http，浏览器会按「混合内容」把接口请求直接拦掉，' +
          '作品墙和留言就会空着 —— 这不是后端坏了，是协议不匹配。');
        lines.push('若后端没开 HTTPS，请退回 <b style="color:#cfe3f5">http://' +
          location.hostname + ':' + HTTP_API_PORT + '</b> 访问本站（页面和接口同源）。');
      }
    } else if (proto === "file:"){
      lines.push('当前是直接双击打开的本地文件，后端地址无法自动推断。');
      lines.push('请改用 <b style="color:#cfe3f5">http://localhost:' + HTTP_API_PORT +
        '</b> 访问本站。');
    } else if (isLocal){
      lines.push('请确认后端服务已启动。');
      lines.push('方式一：双击 <code style="color:#ff8a9c">D:\\ZFSN-server\\启动服务.bat</code>');
      lines.push('方式二：在该目录执行 <code style="color:#ff8a9c">node server.js</code>');
      lines.push('（注：开机自启计划任务会自动拉起，正常无需手动操作）');
    } else {
      // 外部访客：本机服务大概率是好的，问题出在网络上
      lines.push('你的浏览器没能连上本站的后端服务。');
      lines.push('如果你是站主：请检查路由器是否把 <b style="color:#ff8a9c">' +
        (location.protocol === "https:" ? HTTPS_API_PORT : HTTP_API_PORT) +
        '</b> 端口映射到了本机，以及 Windows 防火墙是否放行。');
      lines.push('如果你是访客：可能是站点暂时离线，稍后再试即可。');
    }
    return lines.join("<br>");
  }

  function loadMessages(){
    api("/api/messages").then(function(d){
      renderMessages(d.items);
      if (gcount) gcount.textContent = d.count;
    }).catch(function(e){
      glist.innerHTML = '<div class="gempty"><span class="ic">⚠</span>' +
        '<div class="t">留言服务暂时连不上</div>' +
        '<div style="margin-top:12px;font-size:11.5px;color:#7a7a8c;line-height:2;text-align:left;max-width:460px;margin-left:auto;margin-right:auto">' +
        backendHelp() +
        '<div style="margin-top:10px;color:#3f3f4d;font-size:10.5px">技术信息：' + esc(e.message) + '</div>' +
        '</div></div>';
      if (gcount) gcount.textContent = "—";
    });
  }

  function loadMyGeo(){
    api("/api/geo").then(function(d){
      myGeo = d;
      if (gmloc) gmloc.textContent = d.region || "未知";
      if (gmine) gmine.textContent = d.region || "未知";
    }).catch(function(){
      if (gmloc) gmloc.textContent = "识别失败";
      if (gmine) gmine.textContent = "—";
    });
  }

  function openModal(){
    gmerr.textContent = "";
    gmask.classList.add("on");
    document.body.classList.add("locked");
    // 重置附件：之前留的图、录音；避免上次写一半的内容混进来
    pendingImages = [];
    pendingVoice = null;
    if (typeof renderAttachPreview === "function") renderAttachPreview();
    setTimeout(function(){ gname.focus(); }, 180);
  }
  function closeModal(){
    gmask.classList.remove("on");
    document.body.classList.remove("locked");
    // 关弹窗时如果还在录，必须停 —— 否则麦克风指示灯一直亮
    if (mediaRecorder && mediaRecorder.state === "recording"){
      mediaRecorder.stop();
    }
  }

  /* ── 附件状态：图片数组 + 单条录音 ── */
  var pendingImages = [];          // [{ dataUrl, name, size }]
  var pendingVoice  = null;        // { dataUrl, duration }
  var mediaRecorder = null;
  var recChunks = [];
  var recStartTs = 0;
  var recTimer = null;
  var imgInput   = $("#gmimg");
  var imgCnt    = $("#gmimg-cnt");
  var recBtn    = $("#gmrec");
  var recLabel  = $("#gmrec-label");
  var preview   = $("#gm-preview");

  function renderAttachPreview(){
    var html = "";
    pendingImages.forEach(function(img, idx){
      html += '<div class="attach-thumb" title="' + esc(img.name || "") + '">' +
        '<img src="' + img.dataUrl + '" alt="待发送的图片：' + esc(img.name || "未命名") + '">' +
        '<span class="attach-thumb-x" data-imgidx="' + idx + '" role="button">×</span>' +
      '</div>';
    });
    if (pendingVoice){
      html += '<div class="attach-voice">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>' +
        '<audio src="' + pendingVoice.dataUrl + '" controls></audio>' +
        '<span class="attach-voice-dur">' + pendingVoice.duration + 's</span>' +
        '<span class="attach-voice-x" data-rmv="1" title="取消录音" role="button">×</span>' +
      '</div>';
    }
    preview.innerHTML = html;
    imgCnt.textContent = pendingImages.length ? "× " + pendingImages.length : "";
    preview.querySelectorAll("[data-imgidx]").forEach(function(x){
      x.addEventListener("click", function(){
        pendingImages.splice(parseInt(x.getAttribute("data-imgidx"), 10), 1);
        renderAttachPreview();
      });
    });
    var rv = preview.querySelector("[data-rmv]");
    if (rv) rv.addEventListener("click", function(){
      pendingVoice = null;
      renderAttachPreview();
    });
  }

  /* 图片选择：限制 4 张、5MB/张；用 FileReader 转 dataURL。
   * 不走 fetch/upload，是因为留言需要一次性 POST，把 base64 嵌进去最简单。 */
  imgInput.addEventListener("change", function(){
    var files = Array.from(imgInput.files || []);
    for (var i = 0; i < files.length; i++){
      if (pendingImages.length >= 4) break;
      (function(f){
        if (!/^image\//i.test(f.type)) { gmerr.textContent = "「" + f.name + "」不是图片"; return; }
        if (f.size > 5*1024*1024){ gmerr.textContent = "「" + f.name + "」超过 5MB，已跳过"; return; }
        var r = new FileReader();
        r.onload = function(ev){
          pendingImages.push({ dataUrl: ev.target.result, name: f.name, size: f.size });
          renderAttachPreview();
        };
        r.readAsDataURL(f);
      })(files[i]);
    }
    imgInput.value = "";   // 清空以便重复选同一张
  });

  /* 录音：MediaRecorder 直接拿麦克风流，结束时拼 Blob 再 dataURL。
   * 注意浏览器要求：localhost 或 https 才放行 getUserMedia；
   * 公网 https (api.zfsnnb.dpdns.org) 走 CF 隧道，但页面本身在
   * www.zfsnnb.dpdns.org（CF Workers）—— 也是 https，没问题。 */
  recBtn.addEventListener("click", function(){
    if (mediaRecorder && mediaRecorder.state === "recording"){
      mediaRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      gmerr.textContent = "当前浏览器不支持录音（需 HTTPS / localhost）";
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
      recChunks = [];
      var mime = (typeof MediaRecorder.isTypeSupported === "function" &&
                  MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
                  ? "audio/webm;codecs=opus" : "";
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime })
                            : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function(e){
        if (e.data && e.data.size) recChunks.push(e.data);
      };
      mediaRecorder.onstop = function(){
        clearInterval(recTimer);
        recBtn.classList.remove("rec");
        recLabel.textContent = "录音";
        stream.getTracks().forEach(function(t){ t.stop(); });
        var blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        if (!blob.size){ return; }
        if (blob.size > 4*1024*1024){
          gmerr.textContent = "录音超过 4MB，已自动丢弃（再短一点）";
          pendingVoice = null;
          renderAttachPreview();
          return;
        }
        var r = new FileReader();
        r.onload = function(ev){
          var dur = Math.max(1, Math.round((Date.now() - recStartTs) / 1000));
          pendingVoice = { dataUrl: ev.target.result, duration: dur };
          renderAttachPreview();
        };
        r.readAsDataURL(blob);
      };
      mediaRecorder.start();
      recStartTs = Date.now();
      recBtn.classList.add("rec");
      recLabel.textContent = "停止 00:00";
      recTimer = setInterval(function(){
        var s = Math.floor((Date.now() - recStartTs) / 1000);
        recLabel.textContent = "停止 " + Math.floor(s/60) + ":" + (s%60 < 10 ? "0" : "") + (s%60);
      }, 250);
    }).catch(function(err){
      gmerr.textContent = "无法访问麦克风：" + (err.message || err.name || "未知错误");
    });
  });

  $("#g-write").addEventListener("click", openModal);
  $("#gclose").addEventListener("click", closeModal);
  gmask.addEventListener("click", function(e){ if (e.target === gmask) closeModal(); });
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape" && gmask.classList.contains("on")) closeModal();
  });

  gtext.addEventListener("input", function(){
    $("#gmtext-cnt").textContent = gtext.value.length;
  });

  gsubmit.addEventListener("click", function(){
    var name = gname.value.trim();
    var text = gtext.value.trim();
    gmerr.innerHTML = "";
    if (!name){ gmerr.textContent = "请填写名字"; gname.focus(); return; }
    if (!text){ gmerr.textContent = "请填写留言内容"; gtext.focus(); return; }

    // 把附件塞进 body；空数组不发送（节省一点 JSON 体积）
    var body = { name: name, text: text };
    if (pendingImages.length) body.images = pendingImages.map(function(x){ return x.dataUrl; });
    if (pendingVoice)         body.voices = [pendingVoice];

    gsubmit.disabled = true;
    gsubmit.textContent = "发布中…";
    api("/api/messages", {
      method: "POST",
      body: JSON.stringify(body)
    }).then(function(d){
      gtext.value = "";
      $("#gmtext-cnt").textContent = "0";
      pendingImages = [];
      pendingVoice = null;
      renderAttachPreview();
      closeModal();
      loadMessages();
      // 让「我的位置」也刷新一下
      if (!myGeo) loadMyGeo();
    }).catch(function(e){
      var msg = e.message || "发布失败";
      gmerr.innerHTML = esc(msg);
      // 后端连不上时，给出可操作的指引
      if (/未启动|Failed to fetch|NetworkError|Load failed/i.test(msg)){
        gmerr.innerHTML = '无法连接后端服务<br>' +
          '<span style="color:#7a7a8c;font-size:11px">' + backendHelp() + '</span>';
      }
    }).then(function(){
      gsubmit.disabled = false;
      gsubmit.textContent = "发布留言";
    });
  });

  gmorebtn.addEventListener("click", gAppendBatch);

  /* ═══ 首页「关于我」 ═══
   * 内容由后台「关于我」标签页维护，存 D1 的 config 表。
   * 只在首页存在容器时拉取 —— 其它页面（作品/详情）不需要这段请求。
   *
   * 渲染要点：
   *   · 纯文本，用 textContent 赋值（不用 innerHTML）—— 从根上杜绝 XSS，
   *     站长自己也省得操心转义。
   *   · 换行靠 CSS 的 white-space:pre-wrap 保留，不做任何 \n → <br> 转换。
   *   · 后端返回 has_content=false（没填 / 全是空白）时整块保持 hidden，
   *     不留一个空壳占位把版式撑开。
   */
  (function initHomeAbout(){
    var box = document.getElementById("home-about");
    if (!box) return;
    var body = document.getElementById("home-about-body");
    if (!body) return;

    api("/api/about").then(function(d){
      if (!d || !d.has_content) return;
      body.textContent = d.text;
      box.hidden = false;
    }).catch(function(){ /* 静默：自我介绍拉不到不影响网站主功能 */ });
  })();

  /* ═══ 启动时应用地址栏路由 ═══
   * 别人分享的 #work/<id> 链接，打开就直接落在作品详情页 ——
   * 这正是"详情页可分享"的意义。
   */
  if (window.__zfsnApplyRoute) window.__zfsnApplyRoute();

  /* 页面打开就预探测后端，这样点「写留言」时已经就绪 */
  detectAPI();
  loadMessages();
  loadMyGeo();

  /* 首次进入也计一次 —— 页面刚打开时不会触发 setActive（没有页面切换），
     只靠 setActive 里的上报会漏掉「直接打开首页/直接打开分享的作品链接」
     这两种最主要的情形。放到最后执行，确保 __zfsnWorkId 已经被
     __zfsnApplyRoute 设好（分享链接直达详情页时要用到）。 */
  countView(typeof window.__zfsnWorkId === "string" && window.__zfsnWorkId &&
            document.body.getAttribute("data-page") === "work"
    ? "work"
    : (document.body.getAttribute("data-page") || "home"));

  /* 暴露给独立模块（弹幕等）使用 */
  window.ZFSN = window.ZFSN || {};
  window.ZFSN.api = api;
  window.ZFSN.getBase = function(){ return API_BASE; };
})();