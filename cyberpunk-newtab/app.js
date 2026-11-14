(() => {
  "use strict";

  const STORAGE_KEY = "nc_home_v1";
  const SCHEMA_VERSION = 1;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const ENGINES = Object.freeze({
    google: { label: "Google", short: "GOOGLE", url: "https://www.google.com/search?q=" },
    bing: { label: "Bing", short: "BING", url: "https://www.bing.com/search?q=" },
    baidu: { label: "百度", short: "BAIDU", url: "https://www.baidu.com/s?wd=" },
    duckduckgo: { label: "DuckDuckGo", short: "DDG", url: "https://duckduckgo.com/?q=" },
    bilibili: { label: "哔哩哔哩", short: "BILIBILI", url: "https://search.bilibili.com/all?keyword=" },
    github: { label: "GitHub", short: "GITHUB", url: "https://github.com/search?q=" }
  });

  const THEMES = Object.freeze({
    night: "NIGHT CITY",
    netrunner: "NETRUNNER",
    afterglow: "AFTERLIFE",
    blackwall: "BLACKWALL"
  });

  const COLORS = Object.freeze(["yellow", "cyan", "red", "magenta"]);

  const DEFAULT_SETTINGS = Object.freeze({
    engine: "google",
    theme: "night",
    motion: true,
    scanlines: true
  });

  const DEFAULT_TILES = Object.freeze([
    { name: "Bing", url: "https://www.bing.com/", tag: "SEARCH", color: "cyan" },
    { name: "哔哩哔哩", url: "https://www.bilibili.com/", tag: "VIDEO", color: "magenta" },
    { name: "苦力怕论坛", url: "https://klpbbs.com/", tag: "MC", color: "yellow" },
    { name: "MC导航", url: "https://www.mcnav.net/", tag: "MC", color: "yellow" },
    { name: "中文百科", url: "https://zh.wikipedia.org/", tag: "WIKI", color: "cyan" },
    { name: "谷歌邮箱", url: "https://mail.google.com/", tag: "MAIL", color: "red" },
    { name: "GitHub", url: "https://github.com/", tag: "CODE", color: "cyan" },
    { name: "路由器配置", url: "http://192.168.0.1/", tag: "LAN", color: "red" },
    { name: "DNS代理", url: "http://192.168.0.1:3000/", tag: "DNS", color: "magenta" },
    { name: "IP 查询", url: "https://www.ip.cn/", tag: "NET", color: "cyan" },
    { name: "ZFSN 主页", url: "https://www.zfsnnb.dpdns.org/", tag: "HOME", color: "yellow" }
  ]);

  const ICONS = {
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
    delete:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v5M14 11v5"/></svg>',
    drag:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>'
  };

  const refs = {
    grid: document.getElementById("tile-grid"),
    tileCount: document.getElementById("tile-count"),
    statNodes: document.getElementById("stat-nodes"),
    statEngine: document.getElementById("stat-engine"),
    clockTime: document.getElementById("clock-time"),
    clockDate: document.getElementById("clock-date"),
    clockZone: document.getElementById("clock-zone"),
    searchForm: document.getElementById("search-form"),
    searchInput: document.getElementById("search-input"),
    engineBtn: document.getElementById("engine-btn"),
    settingsBtn: document.getElementById("settings-btn"),
    quickAdd: document.getElementById("quick-add"),
    tileDialog: document.getElementById("tile-dialog"),
    tileForm: document.getElementById("tile-form"),
    tileDialogKicker: document.getElementById("tile-dialog-kicker"),
    tileDialogTitle: document.getElementById("tile-dialog-title"),
    tileSubmit: document.getElementById("tile-submit"),
    tileName: document.getElementById("tile-name"),
    tileUrl: document.getElementById("tile-url"),
    tileIcon: document.getElementById("tile-icon"),
    tileTag: document.getElementById("tile-tag"),
    tileColors: document.getElementById("tile-colors"),
    tileError: document.getElementById("tile-error"),
    settingsDialog: document.getElementById("settings-dialog"),
    settingEngine: document.getElementById("setting-engine"),
    settingMotion: document.getElementById("setting-motion"),
    settingScanlines: document.getElementById("setting-scanlines"),
    themeGrid: document.getElementById("theme-grid"),
    exportBtn: document.getElementById("export-btn"),
    importBtn: document.getElementById("import-btn"),
    importFile: document.getElementById("import-file"),
    resetBtn: document.getElementById("reset-btn"),
    clearBtn: document.getElementById("clear-btn"),
    toast: document.getElementById("toast")
  };

  const hasChromeStorage =
    typeof chrome !== "undefined" && Boolean(chrome.storage && chrome.storage.local);
  const hasFaviconApi =
    typeof chrome !== "undefined" &&
    Boolean(chrome.runtime && typeof chrome.runtime.getURL === "function");

  let state = createDefaultState();
  let editingId = null;
  let dragId = null;
  let toastTimer = null;
  let toastHideTimer = null;

  /* ── Utilities ──────────────────────────────────────────────────────── */

  function uid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function cleanText(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function monogram(name) {
    const chars = Array.from(String(name || "").trim());
    return (chars[0] || "#").toUpperCase();
  }

  function normalizeUrl(raw) {
    let value = String(raw || "").trim();
    if (!value) return null;
    if (/^(javascript|data|vbscript|file|chrome|chrome-extension|about|edge):/i.test(value)) {
      return null;
    }
    if (/^\/\//.test(value)) value = `https:${value}`;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const isLocal =
        /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value) ||
        /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(value);
      value = `${isLocal ? "http" : "https"}://${value}`;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function looksLikeUrl(value) {
    if (/\s/.test(value)) return false;
    if (/^https?:\/\//i.test(value)) return true;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(value)) return true;
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i.test(value);
  }

  function normalizeIcon(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/i.test(value)) return value;
    if (
      /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value) &&
      /\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#].*)?$/i.test(value)
    ) {
      return `https://${value}`;
    }
    return value;
  }

  function titleFromUrl(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./i, "");
      return host.split(".")[0] || host || "NODE";
    } catch {
      return "NODE";
    }
  }

  function normalizeTile(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    const url = normalizeUrl(raw.url);
    if (!url) return null;
    const name = cleanText(raw.name, 40) || titleFromUrl(url);
    const tag = cleanText(raw.tag, 16).toUpperCase();
    const color = COLORS.includes(raw.color) ? raw.color : COLORS[index % COLORS.length];
    return {
      id: cleanText(raw.id, 80) || uid(),
      name,
      url,
      icon: normalizeIcon(raw.icon),
      tag,
      color
    };
  }

  function normalizeSettings(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    return {
      engine: Object.prototype.hasOwnProperty.call(ENGINES, value.engine)
        ? value.engine
        : DEFAULT_SETTINGS.engine,
      theme: Object.prototype.hasOwnProperty.call(THEMES, value.theme)
        ? value.theme
        : DEFAULT_SETTINGS.theme,
      motion: value.motion !== false,
      scanlines: value.scanlines !== false
    };
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.tiles)) {
      return createDefaultState();
    }
    const tiles = raw.tiles.map(normalizeTile).filter(Boolean);
    if (raw.tiles.length > 0 && tiles.length === 0) {
      return createDefaultState();
    }
    const seen = new Set();
    for (const tile of tiles) {
      if (seen.has(tile.id)) tile.id = uid();
      seen.add(tile.id);
    }
    return {
      version: SCHEMA_VERSION,
      tiles,
      settings: normalizeSettings(raw.settings)
    };
  }

  function createDefaultState() {
    return {
      version: SCHEMA_VERSION,
      tiles: DEFAULT_TILES.map((tile, index) => ({
        id: uid(),
        name: tile.name,
        url: tile.url,
        icon: "",
        tag: tile.tag,
        color: tile.color || COLORS[index % COLORS.length]
      })),
      settings: { ...DEFAULT_SETTINGS }
    };
  }

  /* ── Storage ────────────────────────────────────────────────────────── */

  function storageGet() {
    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get(STORAGE_KEY, (result) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(result ? result[STORAGE_KEY] : undefined);
        });
      });
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return Promise.resolve(raw ? JSON.parse(raw) : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  function storageSet(value) {
    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [STORAGE_KEY]: value }, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function saveState() {
    try {
      await storageSet(state);
    } catch (error) {
      console.error("ZFSN://HOME storage error", error);
      showToast(`保存失败：${error.message}`, true);
    }
  }

  function listenForStorageChanges() {
    if (!hasChromeStorage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) return;
      state = normalizeState(changes[STORAGE_KEY].newValue);
      renderAll();
    });
  }

  function showToast(message, isError = false) {
    if (!refs.toast) return;
    if (toastTimer) window.clearTimeout(toastTimer);
    if (toastHideTimer) window.clearTimeout(toastHideTimer);
    refs.toast.textContent = message;
    refs.toast.classList.toggle("toast--error", Boolean(isError));
    refs.toast.hidden = false;
    window.requestAnimationFrame(() => {
      refs.toast.classList.add("is-visible");
    });
    toastTimer = window.setTimeout(() => {
      refs.toast.classList.remove("is-visible");
      toastHideTimer = window.setTimeout(() => {
        refs.toast.hidden = true;
      }, 220);
    }, 2200);
  }

  /* ── Rendering ──────────────────────────────────────────────────────── */

  function findTile(id) {
    return state.tiles.find((tile) => tile.id === id) || null;
  }

  function tileTarget(tile) {
    try {
      const url = new URL(tile.url);
      return { host: url.hostname, origin: url.origin };
    } catch {
      return null;
    }
  }

  /* 内网地址（路由器、NAS、localhost）公共图标服务抓不到，只能直连站点自己。 */
  function isPrivateHost(host) {
    return (
      host === "localhost" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
      /\.(?:local|lan|home|internal)$/i.test(host)
    );
  }

  /* 公共 favicon 服务：站点没放 /favicon.ico（或它 404）时兜底。
     顺序按「国内网络能不能直连」排：favicon.im 走得通，DDG / Google 通常需要代理。 */
  const PUBLIC_ICON_SERVICES = [
    (host) => `https://favicon.im/${host}?larger=true`,
    (host) => `https://icons.duckduckgo.com/ip3/${host}.ico`,
    (host) => `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  ];

  /* 图标候选列表：按顺序试，加载失败自动换下一个，全失败才退回名称首字。
     1. 扩展环境：Chromium 本地 favicon 缓存（离线可用、不联网、画质最好）
     2. 站点自己的 /favicon.ico（内网设备只有这一条路）
     3. 公共图标服务（预览环境没有 chrome API，靠它们才能显示真图标） */
  function iconSources(tile) {
    const sources = [];
    if (hasFaviconApi) {
      sources.push(
        chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tile.url)}&size=64`)
      );
    }
    const target = tileTarget(tile);
    if (target) {
      sources.push(`${target.origin}/favicon.ico`);
      if (!isPrivateHost(target.host)) {
        for (const build of PUBLIC_ICON_SERVICES) sources.push(build(target.host));
      }
    }
    return sources;
  }

  function iconSpec(tile) {
    if (tile.icon) {
      if (/^(?:https?:\/\/|data:image\/)/i.test(tile.icon)) {
        return { type: "image", sources: [tile.icon] };
      }
      return { type: "text", text: Array.from(tile.icon).slice(0, 2).join("") };
    }
    const sources = iconSources(tile);
    if (sources.length) return { type: "image", sources };
    return { type: "text", text: monogram(tile.name) };
  }

  function makeToolButton(action, tile) {
    const labels = { edit: "编辑", delete: "删除", drag: "拖动排序" };
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      `tile__tool${action === "delete" ? " tile__tool--danger" : ""}` +
      `${action === "drag" ? " tile__drag" : ""}`;
    button.dataset.action = action;
    button.title = labels[action];
    button.setAttribute("aria-label", `${labels[action]} ${tile.name}`);
    button.innerHTML = ICONS[action];
    if (action === "drag") button.draggable = true;
    return button;
  }

  function createTileElement(tile, index) {
    const article = document.createElement("article");
    article.className = `tile tile--${tile.color}`;
    article.dataset.id = tile.id;
    article.style.setProperty("--i", String(index));

    const link = document.createElement("a");
    link.className = "tile__link";
    link.href = tile.url;
    link.title = tile.url;
    link.rel = "noopener noreferrer";
    link.setAttribute("draggable", "false");

    const indexNode = document.createElement("span");
    indexNode.className = "tile__index";
    indexNode.textContent = pad2(index + 1);
    indexNode.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "tile__icon";
    icon.setAttribute("aria-hidden", "true");
    const spec = iconSpec(tile);
    if (spec.type === "image") {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.draggable = false;
      /* 图标没到手之前先显示站点首字，不会出现一块空白方格。 */
      const fallback = document.createElement("span");
      fallback.className = "tile__monogram";
      fallback.textContent = monogram(tile.name);
      /* 一个来源挂了就换下一个（站点没放 favicon、被墙、404 都会触发 error），
         全部试完就停在下标上显示首字。 */
      let attempt = 0;
      let settled = false;
      const tryNext = () => {
        if (settled) return;
        if (attempt >= spec.sources.length) {
          settled = true;
          img.remove();
          return;
        }
        img.src = spec.sources[attempt++];
      };
      img.addEventListener("load", () => {
        if (settled || img.naturalWidth === 0) return;
        settled = true;
        img.classList.add("is-loaded");
        fallback.hidden = true;
      });
      img.addEventListener("error", tryNext);
      icon.append(fallback, img);
      tryNext();
    } else {
      const monogramNode = document.createElement("span");
      monogramNode.className = "tile__monogram";
      monogramNode.textContent = spec.text;
      icon.append(monogramNode);
    }

    const name = document.createElement("span");
    name.className = "tile__name";
    name.textContent = tile.name;

    const tag = document.createElement("span");
    tag.className = "tile__tag";
    tag.textContent = tile.tag || "NODE";

    link.append(indexNode, icon, name, tag);

    const tools = document.createElement("div");
    tools.className = "tile__tools";
    tools.append(
      makeToolButton("edit", tile),
      makeToolButton("delete", tile),
      makeToolButton("drag", tile)
    );

    article.append(link, tools);
    return article;
  }

  function createAddTile() {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "tile-add";
    button.className = "tile tile--add";
    button.dataset.action = "add";
    button.setAttribute("aria-label", "添加磁贴");
    button.innerHTML =
      '<span class="tile-add__plus" aria-hidden="true">+</span>' +
      '<span class="tile-add__label">ADD NODE</span>' +
      '<span class="tile-add__sub">添加磁贴</span>';
    return button;
  }

  function renderTiles() {
    const fragment = document.createDocumentFragment();
    state.tiles.forEach((tile, index) => {
      fragment.appendChild(createTileElement(tile, index));
    });
    fragment.appendChild(createAddTile());
    refs.grid.replaceChildren(fragment);
  }

  function updateMeta() {
    const engine = ENGINES[state.settings.engine] || ENGINES.google;
    const count = state.tiles.length;
    refs.engineBtn.textContent = engine.short;
    refs.engineBtn.setAttribute("aria-label", `切换搜索引擎，当前 ${engine.label}`);
    refs.searchInput.placeholder = `在 ${engine.label} 中搜索，或输入网址 / IP ...`;
    refs.statEngine.textContent = engine.short;
    refs.tileCount.textContent = `${count} ${count === 1 ? "NODE" : "NODES"}`;
    refs.statNodes.textContent = String(count);
  }

  function syncSettingsUi() {
    refs.settingEngine.value = state.settings.engine;
    refs.settingMotion.checked = state.settings.motion;
    refs.settingScanlines.checked = state.settings.scanlines;
    for (const button of refs.themeGrid.querySelectorAll("[data-theme]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.theme === state.settings.theme)
      );
    }
  }

  function applyPreferences() {
    const root = document.documentElement;
    root.dataset.theme = state.settings.theme;
    root.dataset.motion = state.settings.motion ? "on" : "off";
    root.dataset.scanlines = state.settings.scanlines ? "on" : "off";
  }

  function renderAll() {
    applyPreferences();
    renderTiles();
    updateMeta();
    syncSettingsUi();
  }

  /* ── Tile dialog ────────────────────────────────────────────────────── */

  function selectedColor() {
    const pressed = refs.tileColors.querySelector('[aria-pressed="true"]');
    return pressed ? pressed.dataset.color : "cyan";
  }

  function setSelectedColor(color) {
    for (const button of refs.tileColors.querySelectorAll("[data-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.color === color));
    }
  }

  function hideFormError() {
    refs.tileError.hidden = true;
    refs.tileError.textContent = "";
  }

  function showFormError(message, focusField) {
    refs.tileError.textContent = message;
    refs.tileError.hidden = false;
    if (focusField) focusField.focus();
  }

  function openTileDialog(tile) {
    if (refs.settingsDialog.open) refs.settingsDialog.close();
    editingId = tile ? tile.id : null;
    refs.tileForm.reset();
    hideFormError();
    refs.tileDialogKicker.textContent = tile ? "// EDIT NODE" : "// NEW NODE";
    refs.tileDialogTitle.textContent = tile ? "EDIT ACCESS POINT" : "ADD ACCESS POINT";
    refs.tileSubmit.textContent = tile ? "SAVE CHANGES" : "SAVE NODE";

    if (tile) {
      refs.tileName.value = tile.name;
      refs.tileUrl.value = tile.url;
      refs.tileIcon.value = tile.icon;
      refs.tileTag.value = tile.tag;
      setSelectedColor(tile.color);
    } else {
      setSelectedColor(COLORS[state.tiles.length % COLORS.length]);
    }

    if (!refs.tileDialog.open) refs.tileDialog.showModal();
    window.setTimeout(() => refs.tileName.focus(), 30);
  }

  function closeOpenDialogs() {
    for (const dialog of [refs.tileDialog, refs.settingsDialog]) {
      if (dialog.open) dialog.close();
    }
  }

  function handleTileSubmit(event) {
    event.preventDefault();
    const name = refs.tileName.value.trim();
    const url = normalizeUrl(refs.tileUrl.value);
    const icon = normalizeIcon(refs.tileIcon.value);
    const tag = refs.tileTag.value.trim().toUpperCase();
    const color = COLORS.includes(selectedColor()) ? selectedColor() : "cyan";

    if (!name) {
      showFormError("请给这个节点起一个名字。", refs.tileName);
      return;
    }
    if (!url) {
      showFormError("这个链接无法识别。请填写 http(s) 地址、域名或局域网 IP。", refs.tileUrl);
      return;
    }
    if (tag.length > 16) {
      showFormError("标签最多 16 个字符。", refs.tileTag);
      return;
    }

    const existing = editingId ? findTile(editingId) : null;
    if (existing) {
      Object.assign(existing, { name, url, icon, tag, color });
    } else {
      state.tiles.push({ id: uid(), name, url, icon, tag, color });
    }

    const wasNew = !existing;
    const newId = existing ? existing.id : state.tiles[state.tiles.length - 1].id;
    saveState();
    renderAll();
    refs.tileDialog.close();
    showToast(existing ? `节点已更新：${name}` : `节点已接入：${name}`);

    if (wasNew) {
      window.setTimeout(() => {
        const element = refs.grid.querySelector(`[data-id="${cssEscape(newId)}"]`);
        if (element) element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 50);
    }
  }

  function deleteTile(id) {
    const tile = findTile(id);
    if (!tile) return;
    if (!window.confirm(`删除节点「${tile.name}」？`)) return;
    state.tiles = state.tiles.filter((item) => item.id !== id);
    saveState();
    renderAll();
    showToast(`节点已移除：${tile.name}`);
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  /* ── Drag sorting ───────────────────────────────────────────────────── */

  function clearDragMarks() {
    for (const element of refs.grid.querySelectorAll(".tile")) {
      element.classList.remove("is-dragging", "drag-over-before", "drag-over-after");
    }
  }

  function cleanupDrag() {
    dragId = null;
    clearDragMarks();
  }

  function reorderTiles(sourceId, targetId, insertAfter) {
    const from = state.tiles.findIndex((tile) => tile.id === sourceId);
    const targetOriginal = state.tiles.findIndex((tile) => tile.id === targetId);
    if (from < 0 || targetOriginal < 0 || from === targetOriginal) return;

    const [item] = state.tiles.splice(from, 1);
    let to = targetOriginal;
    if (from < targetOriginal) to -= 1;
    if (insertAfter) to += 1;
    state.tiles.splice(to, 0, item);

    saveState();
    renderTiles();
    updateMeta();
    showToast("节点顺序已更新");
  }

  function handleDragStart(event) {
    const handle = event.target.closest(".tile__drag");
    if (!handle) {
      if (event.target.closest(".tile")) event.preventDefault();
      return;
    }
    const tileElement = handle.closest(".tile");
    if (!tileElement) return;
    dragId = tileElement.dataset.id;
    tileElement.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragId);
    try {
      event.dataTransfer.setDragImage(tileElement, 24, 24);
    } catch {
      /* setDragImage is best effort */
    }
  }

  function handleDragOver(event) {
    if (!dragId) return;
    const target = event.target.closest(".tile:not(.tile--add)");
    if (!target || target.dataset.id === dragId) {
      clearDragMarks();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDragMarks();
    const rect = target.getBoundingClientRect();
    const insertAfter = event.clientX > rect.left + rect.width / 2;
    target.classList.add(insertAfter ? "drag-over-after" : "drag-over-before");
  }

  function handleDrop(event) {
    if (!dragId) return;
    const target = event.target.closest(".tile:not(.tile--add)");
    if (!target) {
      cleanupDrag();
      return;
    }
    event.preventDefault();
    if (target.dataset.id !== dragId) {
      const rect = target.getBoundingClientRect();
      const insertAfter = event.clientX > rect.left + rect.width / 2;
      reorderTiles(dragId, target.dataset.id, insertAfter);
    }
    cleanupDrag();
  }

  /* ── Settings / data ────────────────────────────────────────────────── */

  function openSettings() {
    if (refs.tileDialog.open) refs.tileDialog.close();
    syncSettingsUi();
    if (!refs.settingsDialog.open) refs.settingsDialog.showModal();
  }

  async function setEngine(engine) {
    if (!Object.prototype.hasOwnProperty.call(ENGINES, engine)) return;
    state.settings.engine = engine;
    applyPreferences();
    updateMeta();
    await saveState();
  }

  function setTheme(theme) {
    if (!Object.prototype.hasOwnProperty.call(THEMES, theme)) return;
    state.settings.theme = theme;
    applyPreferences();
    syncSettingsUi();
    saveState();
  }

  async function exportBackup() {
    const payload = {
      app: "ZFSN://HOME",
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tiles: clone(state.tiles),
      settings: { ...state.settings }
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stamp = new Date();
      link.href = url;
      link.download = `nc-home-backup-${stamp.getFullYear()}${pad2(
        stamp.getMonth() + 1
      )}${pad2(stamp.getDate())}-${pad2(stamp.getHours())}${pad2(
        stamp.getMinutes()
      )}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1200);
      showToast("备份已导出");
    } catch (error) {
      showToast(`导出失败：${error.message}`, true);
    }
  }

  function importBackup(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast("导入失败：备份文件太大", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const imported = parsed && Array.isArray(parsed.tiles) ? parsed : null;
        if (!imported) throw new Error("文件里没有有效的 tiles 数组");
        const next = normalizeState(imported);
        if (
          !window.confirm(
            `导入 ${next.tiles.length} 个节点并覆盖当前磁贴和设置？\n建议先导出当前备份。`
          )
        ) {
          return;
        }
        state = next;
        saveState();
        renderAll();
        showToast(`已导入 ${state.tiles.length} 个节点`);
      } catch (error) {
        showToast(`导入失败：${error.message}`, true);
      }
    };
    reader.onerror = () => showToast("导入失败：无法读取文件", true);
    reader.readAsText(file);
  }

  async function resetToDefaults() {
    if (!window.confirm("恢复示例磁贴和默认设置？当前磁贴将被覆盖。")) return;
    state = createDefaultState();
    await saveState();
    renderAll();
    showToast("已恢复示例设置");
  }

  async function clearTiles() {
    if (!window.confirm("清空全部磁贴？此操作不可撤销，建议先导出备份。")) return;
    state.tiles = [];
    await saveState();
    renderAll();
    showToast("全部节点已移除");
  }

  /* ── Search ─────────────────────────────────────────────────────────── */

  function handleSearch(event) {
    event.preventDefault();
    const query = refs.searchInput.value.trim();
    if (!query) {
      refs.searchInput.focus();
      return;
    }
    if (looksLikeUrl(query)) {
      const target = normalizeUrl(query);
      if (target) {
        window.location.assign(target);
        return;
      }
    }
    const engine = ENGINES[state.settings.engine] || ENGINES.google;
    window.location.assign(engine.url + encodeURIComponent(query));
  }

  function cycleEngine() {
    const keys = Object.keys(ENGINES);
    const current = keys.indexOf(state.settings.engine);
    const next = keys[(current + 1) % keys.length];
    setEngine(next);
    showToast(`搜索引擎：${ENGINES[next].label}`);
  }

  /* ── Clock ──────────────────────────────────────────────────────────── */

  function updateClock() {
    const now = new Date();
    refs.clockTime.textContent = `${pad2(now.getHours())}:${pad2(
      now.getMinutes()
    )}:${pad2(now.getSeconds())}`;
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    refs.clockDate.textContent = `${now.getFullYear()}.${pad2(
      now.getMonth() + 1
    )}.${pad2(now.getDate())} // ${days[now.getDay()]}`;
    const offset = -now.getTimezoneOffset() / 60;
    const sign = offset >= 0 ? "+" : "-";
    const absolute = Math.abs(offset);
    const hours = String(Math.floor(absolute)).padStart(2, "0");
    const minutes = Math.round((absolute % 1) * 60);
    refs.clockZone.textContent = `UTC${sign}${hours}${
      minutes ? `:${pad2(minutes)}` : ""
    }`;
  }

  /* ── Skyline (original generated art) ───────────────────────────────── */

  function mulberry32(seed) {
    return function random() {
      let value = (seed += 0x6d2b79f5);
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function svgNode(tagName, attributes) {
    const node = document.createElementNS(SVG_NS, tagName);
    if (attributes) {
      for (const [name, value] of Object.entries(attributes)) {
        node.setAttribute(name, String(value));
      }
    }
    return node;
  }

  function buildSkyline() {
    const layers = [
      {
        id: "skyline-back",
        className: "bldg bldg--back",
        count: 27,
        minWidth: 32,
        maxWidth: 82,
        minHeight: 70,
        maxHeight: 300,
        windowX: 16,
        windowY: 23,
        litRatio: 0.16,
        signChance: 0
      },
      {
        id: "skyline-mid",
        className: "bldg bldg--mid",
        count: 18,
        minWidth: 52,
        maxWidth: 112,
        minHeight: 125,
        maxHeight: 410,
        windowX: 15,
        windowY: 20,
        litRatio: 0.2,
        signChance: 0.1
      },
      {
        id: "skyline-front",
        className: "bldg",
        count: 13,
        minWidth: 72,
        maxWidth: 158,
        minHeight: 175,
        maxHeight: 500,
        windowX: 14,
        windowY: 18,
        litRatio: 0.24,
        signChance: 0.34
      }
    ];
    const signTexts = ["夜之城", "神经链接", "义体诊所", "数据黑市", "接入点"];
    const signsGroup = document.getElementById("skyline-signs");
    const random = mulberry32(2077);
    let signIndex = 0;

    for (const layer of layers) {
      const group = document.getElementById(layer.id);
      if (!group) continue;
      let x = -44;
      for (let index = 0; index < layer.count; index += 1) {
        const width = Math.round(
          layer.minWidth + random() * (layer.maxWidth - layer.minWidth)
        );
        const height = Math.round(
          layer.minHeight + random() * (layer.maxHeight - layer.minHeight)
        );
        const y = 620 - height;

        group.appendChild(
          svgNode("rect", {
            x,
            y,
            width,
            height,
            class: layer.className
          })
        );

        if (random() > 0.56) {
          const setbackWidth = Math.round(width * (0.28 + random() * 0.36));
          const setbackHeight = Math.round(12 + random() * 50);
          group.appendChild(
            svgNode("rect", {
              x: x + (width - setbackWidth) / 2,
              y: y - setbackHeight,
              width: setbackWidth,
              height: setbackHeight,
              class: layer.className
            })
          );
        }

        if (random() > 0.46) {
          const antennaX = x + width * (0.25 + random() * 0.5);
          const antennaHeight = Math.round(16 + random() * 66);
          group.appendChild(
            svgNode("line", {
              x1: antennaX,
              y1: y,
              x2: antennaX,
              y2: y - antennaHeight,
              class: "antenna"
            })
          );
          if (random() > 0.4) {
            group.appendChild(
              svgNode("circle", {
                cx: antennaX,
                cy: y - antennaHeight,
                r: 1.5,
                class: "antenna-dot"
              })
            );
          }
        }

        const columns = Math.floor((width - 12) / layer.windowX);
        const rows = Math.floor((height - 18) / layer.windowY);
        for (let column = 0; column < columns; column += 1) {
          for (let row = 0; row < rows; row += 1) {
            if (random() > layer.litRatio) continue;
            const value = random();
            const windowClass =
              value > 0.86 ? "win win--red" : value > 0.72 ? "win win--warm" : "win";
            group.appendChild(
              svgNode("rect", {
                x: x + 8 + column * layer.windowX,
                y: y + 10 + row * layer.windowY,
                width: 3,
                height: 4,
                class: windowClass
              })
            );
          }
        }

        if (layer.signChance > 0 && signsGroup && random() < layer.signChance) {
          const sign = svgNode("text", {
            x: x + width * 0.68,
            y: y + 20
          });
          sign.textContent = signTexts[signIndex % signTexts.length];
          signIndex += 1;
          signsGroup.appendChild(sign);
          signsGroup.appendChild(
            svgNode("rect", {
              x: x + width * 0.68 - 8,
              y: y + 12,
              width: 1,
              height: 74,
              class: "sign-bar"
            })
          );
        }

        x += width + 4 + Math.round(random() * 15);
      }
    }

    const skyline = document.querySelector(".scene__skyline");
    if (skyline) {
      skyline.appendChild(
        svgNode("line", {
          x1: 0,
          y1: 620,
          x2: 1920,
          y2: 620,
          stroke: "rgba(117,238,236,0.2)",
          "stroke-width": 1
        })
      );
    }
  }

  /* ── Events ─────────────────────────────────────────────────────────── */

  function bindEvents() {
    refs.searchForm.addEventListener("submit", handleSearch);
    refs.engineBtn.addEventListener("click", cycleEngine);
    refs.settingsBtn.addEventListener("click", openSettings);
    refs.quickAdd.addEventListener("click", () => openTileDialog(null));

    refs.grid.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (!action) return;
      const tileElement = action.closest(".tile");
      if (!tileElement) return;
      const tileId = tileElement.dataset.id;

      if (action.dataset.action === "add") {
        event.preventDefault();
        openTileDialog(null);
        return;
      }
      if (action.dataset.action === "edit") {
        event.preventDefault();
        const tile = findTile(tileId);
        if (tile) openTileDialog(tile);
        return;
      }
      if (action.dataset.action === "delete") {
        event.preventDefault();
        deleteTile(tileId);
      }
    });

    refs.grid.addEventListener("dragstart", handleDragStart);
    refs.grid.addEventListener("dragover", handleDragOver);
    refs.grid.addEventListener("drop", handleDrop);
    refs.grid.addEventListener("dragend", cleanupDrag);

    refs.tileColors.addEventListener("click", (event) => {
      const swatch = event.target.closest("[data-color]");
      if (!swatch) return;
      setSelectedColor(swatch.dataset.color);
    });

    refs.tileForm.addEventListener("submit", handleTileSubmit);
    refs.tileDialog.addEventListener("close", () => {
      editingId = null;
      refs.tileForm.reset();
      hideFormError();
      setSelectedColor("cyan");
    });

    refs.settingEngine.addEventListener("change", () => {
      setEngine(refs.settingEngine.value);
    });

    refs.themeGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-theme]");
      if (!button) return;
      setTheme(button.dataset.theme);
    });

    refs.settingMotion.addEventListener("change", () => {
      state.settings.motion = refs.settingMotion.checked;
      applyPreferences();
      saveState();
    });

    refs.settingScanlines.addEventListener("change", () => {
      state.settings.scanlines = refs.settingScanlines.checked;
      applyPreferences();
      saveState();
    });

    refs.exportBtn.addEventListener("click", exportBackup);
    refs.importBtn.addEventListener("click", () => refs.importFile.click());
    refs.importFile.addEventListener("change", () => {
      const file = refs.importFile.files && refs.importFile.files[0];
      refs.importFile.value = "";
      importBackup(file);
    });
    refs.resetBtn.addEventListener("click", resetToDefaults);
    refs.clearBtn.addEventListener("click", clearTiles);

    document.addEventListener("click", (event) => {
      const closeButton = event.target.closest("[data-close-dialog]");
      if (!closeButton) return;
      const dialog = document.getElementById(closeButton.dataset.closeDialog);
      if (dialog && dialog.open) dialog.close();
    });

    for (const dialog of [refs.tileDialog, refs.settingsDialog]) {
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        if (!inside) dialog.close();
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      const typing =
        event.target instanceof Element &&
        (event.target.matches("input, textarea, select") ||
          event.target.isContentEditable);

      if (event.key === "Escape" && document.activeElement === refs.searchInput) {
        refs.searchInput.value = "";
        refs.searchInput.blur();
        return;
      }

      if (refs.tileDialog.open || refs.settingsDialog.open) return;
      if (typing) return;

      if (
        event.key === "/" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")
      ) {
        event.preventDefault();
        refs.searchInput.focus();
        refs.searchInput.select();
        return;
      }

      if (
        event.key.toLowerCase() === "n" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        openTileDialog(null);
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateClock();
    });
  }

  /* ── Boot ───────────────────────────────────────────────────────────── */

  async function init() {
    buildSkyline();
    updateClock();
    window.setInterval(updateClock, 1000);
    bindEvents();

    try {
      const stored = await storageGet();
      if (stored === undefined) {
        state = createDefaultState();
        await storageSet(state);
      } else {
        const normalized = normalizeState(stored);
        state = normalized;
        if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
          await storageSet(normalized);
        }
      }
    } catch (error) {
      console.error("ZFSN://HOME load error", error);
      state = createDefaultState();
      showToast("读取本地数据失败，已使用示例磁贴", true);
    }

    renderAll();
    listenForStorageChanges();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
