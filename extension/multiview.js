// 多屏播放引擎（共享模块）
// - 在 youtube.com 上作为全屏覆盖层运行（content script 注入）
// - 在 player.html 独立页上以 standalone 模式运行
// 依赖 common.js（MAX_VIDEOS / parseOne / extractIds），先于本文件加载。
// 注意：youtube.com 强制 Trusted Types，本文件禁止使用 innerHTML，全部 createElement。

'use strict';

const MultiView = (() => {
  const YT_ORIGIN = 'https://www.youtube.com';
  const YT_NOCOOKIE_ORIGIN = 'https://www.youtube-nocookie.com';
  const YT_ORIGINS = [YT_ORIGIN, YT_NOCOOKIE_ORIGIN];
  // youtube.com 页内嵌 www.youtube.com/embed 会被一律以 152 拒绝（实测），
  // nocookie 域名不受此限制，故默认用它；失败时再互换域名重试一次。
  const DEFAULT_EMBED_ORIGIN = YT_NOCOOKIE_ORIGIN;
  const STATE_KEY = 'myv_state';
  const PENDING_KEY = 'myv_pending';

  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  // 扩展被重载后，旧页面里的脚本调用 chrome.storage 会抛 "Extension context invalidated"，
  // 一律静默吞掉（刷新页面即恢复）
  const store = {
    async get(key) {
      if (hasChromeStorage) {
        try { return (await chrome.storage.local.get(key))[key]; } catch { return undefined; }
      }
      try { return JSON.parse(localStorage.getItem(key)); } catch { return undefined; }
    },
    async set(key, value) {
      if (hasChromeStorage) {
        try { await chrome.storage.local.set({ [key]: value }); } catch { /* stale context */ }
        return;
      }
      localStorage.setItem(key, JSON.stringify(value));
    }
  };

  // ---------- 内部状态 ----------
  let opts = {};                    // {onStatus}
  let mounted = false;
  let loaded = false;               // 是否已从 storage 恢复
  let visible = false;
  let state = { videos: [], mode: 'grid', hoverAudio: true };  // videos: [{uid,id,start,free:{x,y,w,h,z}}]
  const players = new Map();        // uid -> {uid,id,tile,iframe,ready,title,playState}
  let focusedUid = null;
  let hoverAudioTimer = null;       // 悬停即听的防抖定时器
  let zTop = 10;
  let uidSeq = 0;
  let saveTimer = null;
  let consumingPending = false;

  // DOM 引用
  let overlay, board, emptyHint, toastEl, counterEl, modeBtn, urlInput, hoverAudioBtn;

  // ---------- 工具 ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(cls, text, title, onClick) {
    const b = el('button', cls, text);
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    b.addEventListener('click', onClick);
    return b;
  }

  function newUid() {
    return 'v' + Date.now().toString(36) + '_' + (++uidSeq) + Math.random().toString(36).slice(2, 6);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.set(STATE_KEY, {
        videos: state.videos.map(v => ({ uid: v.uid, id: v.id, start: v.start || 0, free: v.free })),
        mode: state.mode,
        hoverAudio: state.hoverAudio
      });
    }, 300);
  }

  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('myv-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('myv-show'), 2400);
  }

  function emitStatus() {
    if (!opts.onStatus) return;
    let playing = false;
    for (const p of players.values()) if (p.playState === 1) { playing = true; break; }
    opts.onStatus({ count: state.videos.length, playing, visible });
  }

  // ---------- YouTube widget postMessage 协议 ----------
  function sendCommand(p, func, args = []) {
    if (!p.iframe.contentWindow) return;
    p.iframe.contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args, id: p.uid, channel: 'widget' }), p.embedOrigin);
  }

  function sendListening(p) {
    if (!p.iframe.contentWindow) return;
    p.iframe.contentWindow.postMessage(
      JSON.stringify({ event: 'listening', id: p.uid, channel: 'widget' }), p.embedOrigin);
  }

  function onWindowMessage(e) {
    if (!YT_ORIGINS.includes(e.origin)) return;
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (!data || !data.id) return;
    const p = players.get(data.id);
    if (!p) return;
    if (data.event === 'onReady') {
      p.ready = true;
      if (p.pendingFocus) { p.pendingFocus = false; setAudioFocus(p.uid); }
    } else if (data.event === 'infoDelivery' && data.info) {
      if (typeof data.info.playerState === 'number') {
        p.playState = data.info.playerState;
        emitStatus();
      }
      const title = data.info.videoData && data.info.videoData.title;
      if (title && title !== p.title) {
        p.title = title;
        const t = p.tile.querySelector('.myv-title');
        t.textContent = title;
        t.title = title;
      }
    } else if (data.event === 'onError') {
      handleTileError(p, data.info);
    }
  }

  // 152/153 = 嵌入方身份被拒。自动换另一个嵌入域名重试一次，仍失败才报错。
  function handleTileError(p, code) {
    if ((code === 152 || code === 153) && !p.retriedOtherOrigin) {
      p.retriedOtherOrigin = true;
      const other = p.embedOrigin === YT_NOCOOKIE_ORIGIN ? YT_ORIGIN : YT_NOCOOKIE_ORIGIN;
      console.warn(`[MultiView] 视频 ${p.id} 被拒（${code}），改用 ${other} 重试`);
      p.embedOrigin = other;
      p.ready = false;
      const video = state.videos.find(v => v.uid === p.uid);
      p.iframe.src = buildEmbedSrc(p.id, true, (video && video.start) || 0, other);
      return;
    }
    showTileError(p, code);
  }

  const ERROR_MESSAGES = {
    2: '无效的视频 ID',
    5: '播放器加载失败',
    100: '视频不存在或已设为私享',
    101: '视频作者禁止了站外嵌入播放',
    150: '视频作者禁止了站外嵌入播放',
    152: 'YouTube 拒绝了嵌入请求（无法识别嵌入方）',
    153: 'YouTube 拒绝了嵌入请求（缺少 Referer 标识）'
  };

  function showTileError(p, code) {
    p.tile.querySelector('.myv-err-msg').textContent =
      ERROR_MESSAGES[code] || `播放出错（错误码 ${code}）`;
    p.tile.classList.add('myv-has-error');
  }

  // ---------- 布局 ----------
  function gridDims(n) {
    if (n <= 1) return [1, 1];
    const cols = Math.ceil(Math.sqrt(n));
    return [cols, Math.ceil(n / cols)];
  }

  function applyGridTemplate() {
    const [cols, rows] = gridDims(state.videos.length);
    board.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    board.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  }

  function applyOrder() {
    state.videos.forEach((v, i) => {
      const p = players.get(v.uid);
      if (p) p.tile.style.order = i;
    });
  }

  function refreshChrome() {
    if (counterEl) counterEl.textContent = `${state.videos.length} / ${MAX_VIDEOS}`;
    board.classList.toggle('myv-has-videos', state.videos.length > 0);
    emitStatus();
  }

  function defaultFreeRect(index) {
    const bw = board.clientWidth || 1200;
    const bh = board.clientHeight || 700;
    const w = Math.max(320, Math.min(480, Math.floor(bw * 0.38)));
    const h = Math.floor(w * 9 / 16) + 0;
    const offset = (index % 6) * 36;
    return {
      x: Math.min(28 + offset, Math.max(0, bw - w - 12)),
      y: Math.min(28 + offset, Math.max(0, bh - h - 12)),
      w, h, z: ++zTop
    };
  }

  function applyFreeRect(video) {
    const p = players.get(video.uid);
    if (!p) return;
    if (!video.free) video.free = defaultFreeRect(state.videos.indexOf(video));
    const r = video.free;
    Object.assign(p.tile.style, {
      left: r.x + 'px', top: r.y + 'px',
      width: r.w + 'px', height: r.h + 'px', zIndex: r.z
    });
    zTop = Math.max(zTop, r.z);
  }

  function clearFreeStyles(tile) {
    tile.style.left = tile.style.top = tile.style.width = tile.style.height = tile.style.zIndex = '';
  }

  function bringToFront(video) {
    if (!video.free) return;
    video.free.z = ++zTop;
    const p = players.get(video.uid);
    if (p) p.tile.style.zIndex = video.free.z;
    scheduleSave();
  }

  function setMode(mode) {
    state.mode = mode;
    board.classList.toggle('myv-grid-mode', mode === 'grid');
    board.classList.toggle('myv-free-mode', mode === 'free');
    if (modeBtn) modeBtn.textContent = mode === 'grid' ? '⧉ 自由布局' : '▦ 网格布局';
    if (mode === 'grid') {
      for (const p of players.values()) clearFreeStyles(p.tile);
      applyGridTemplate();
      applyOrder();
    } else {
      board.style.gridTemplateColumns = '';
      board.style.gridTemplateRows = '';
      for (const v of state.videos) applyFreeRect(v);
    }
    scheduleSave();
  }

  // ---------- 音频焦点 ----------
  function setAudioFocus(uid) {
    focusedUid = uid;
    for (const [pUid, p] of players) {
      const isFocus = pUid === uid;
      p.tile.classList.toggle('myv-audio-focus', isFocus);
      const sb = p.tile.querySelector('.myv-btn-sound');
      sb.classList.toggle('myv-active', isFocus);
      sb.textContent = isFocus ? '🔊' : '🔇';
      if (isFocus) {
        sendCommand(p, 'unMute');
        sendCommand(p, 'setVolume', [100]);
      } else {
        sendCommand(p, 'mute');
      }
    }
  }

  // ---------- 添加 / 移除 ----------
  function buildEmbedSrc(id, autoplay, start, embedOrigin = DEFAULT_EMBED_ORIGIN) {
    const params = new URLSearchParams({
      enablejsapi: '1',
      autoplay: autoplay ? '1' : '0',
      mute: '1',
      playsinline: '1',
      rel: '0',
      // 标记参数：declarativeNetRequest 规则（rules.json）只对带 myv=1 的 embed 请求
      // 改写 Referer 为中性身份。YouTube 服务器按 Referer 判定嵌入方，
      // 「youtube.com 嵌 youtube.com」会被一律以 152 拒绝，必须换身份。
      myv: '1'
    });
    if (start > 0) params.set('start', String(Math.floor(start)));
    return `${embedOrigin}/embed/${id}?${params}`;
  }

  function addVideo(id, { autoplay = true, start = 0, focus = false, save = true } = {}) {
    if (state.videos.length >= MAX_VIDEOS) {
      toast(`最多同时播放 ${MAX_VIDEOS} 个视频`);
      return null;
    }
    const video = { uid: newUid(), id, start, free: null };
    state.videos.push(video);
    createTile(video, autoplay, focus);
    if (state.mode === 'grid') { applyGridTemplate(); applyOrder(); }
    else applyFreeRect(video);
    refreshChrome();
    if (save) scheduleSave();
    return video;
  }

  function removeVideo(uid) {
    const idx = state.videos.findIndex(v => v.uid === uid);
    if (idx === -1) return;
    state.videos.splice(idx, 1);
    const p = players.get(uid);
    if (p) { p.tile.remove(); players.delete(uid); }
    if (focusedUid === uid) focusedUid = null;
    if (state.mode === 'grid') { applyGridTemplate(); applyOrder(); }
    refreshChrome();
    scheduleSave();
  }

  function createTile(video, autoplay, focus) {
    const tile = el('div', 'myv-tile');
    tile.dataset.uid = video.uid;

    const iframe = document.createElement('iframe');
    iframe.src = buildEmbedSrc(video.id, autoplay, video.start || 0);
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';

    const header = el('div', 'myv-tile-header');
    const titleEl = el('span', 'myv-title', video.id);
    titleEl.title = '拖动可移动 / 交换位置';
    const soundBtn = btn('myv-btn-sound', '🔇', '听这个视频（其余自动静音）', () => {
      setAudioFocus(focusedUid === video.uid ? null : video.uid);
    });
    const openBtn = btn('myv-btn-open', '↗', '在 YouTube 打开', () => {
      window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
    });
    const closeBtn = btn('myv-btn-close', '✕', '移除', () => removeVideo(video.uid));
    header.append(titleEl, soundBtn, openBtn, closeBtn);

    const focusRing = el('div', 'myv-focus-ring');

    const errEl = el('div', 'myv-tile-error');
    const errMsg = el('div', 'myv-err-msg');
    const errLink = el('a', null, '在 YouTube 中打开 ↗');
    errLink.href = `https://www.youtube.com/watch?v=${video.id}`;
    errLink.target = '_blank';
    errLink.rel = 'noopener';
    errEl.append(errMsg, errLink);

    const resizeHandle = el('div', 'myv-resize-handle');

    tile.append(iframe, header, focusRing, errEl, resizeHandle);
    board.appendChild(tile);

    const p = {
      uid: video.uid, id: video.id, tile, iframe,
      ready: false, title: video.id, playState: -1, pendingFocus: !!focus,
      embedOrigin: DEFAULT_EMBED_ORIGIN, retriedOtherOrigin: false
    };
    players.set(video.uid, p);

    iframe.addEventListener('load', () => {
      const origin = p.embedOrigin;
      sendListening(p);
      // widget 偶尔错过第一条 listening；补发前确认没有因重试而换域名
      setTimeout(() => { if (p.embedOrigin === origin) sendListening(p); }, 800);
    });

    tile.addEventListener('pointerdown', () => {
      if (state.mode === 'free') bringToFront(video);
    });

    // 悬停即听：鼠标停在哪个视频上就听哪个（小防抖，快速扫过不抢声音）
    tile.addEventListener('pointerenter', () => {
      if (!state.hoverAudio || overlay.classList.contains('myv-dragging-any')) return;
      clearTimeout(hoverAudioTimer);
      hoverAudioTimer = setTimeout(() => {
        if (focusedUid !== video.uid && players.has(video.uid)) setAudioFocus(video.uid);
      }, 150);
    });
    tile.addEventListener('pointerleave', () => clearTimeout(hoverAudioTimer));
    titleEl.addEventListener('pointerdown', (e) => startDrag(e, video, titleEl));
    resizeHandle.addEventListener('pointerdown', (e) => startResize(e, video, resizeHandle));
  }

  // ---------- 拖动 / 缩放（pointer capture，iframe 不会吞事件） ----------
  function startDrag(e, video, handleEl) {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = players.get(video.uid);
    if (!p) return;

    handleEl.setPointerCapture(e.pointerId);
    overlay.classList.add('myv-dragging-any');
    p.tile.classList.add('myv-dragging');

    const startX = e.clientX, startY = e.clientY;
    let dropTarget = null;
    if (state.mode === 'free' && !video.free) {
      video.free = defaultFreeRect(state.videos.indexOf(video));
    }
    const startRect = video.free ? { ...video.free } : null;

    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (state.mode === 'free') {
        const r = video.free;
        r.x = Math.max(-r.w + 80, Math.min(startRect.x + dx, board.clientWidth - 80));
        r.y = Math.max(0, Math.min(startRect.y + dy, board.clientHeight - 40));
        p.tile.style.left = r.x + 'px';
        p.tile.style.top = r.y + 'px';
      } else {
        p.tile.style.transform = `translate(${dx}px, ${dy}px)`;
        const target = tileAtPoint(ev.clientX, ev.clientY, video.uid);
        if (target !== dropTarget) {
          if (dropTarget) dropTarget.classList.remove('myv-drop-target');
          dropTarget = target;
          if (dropTarget) dropTarget.classList.add('myv-drop-target');
        }
      }
    };

    const onUp = () => {
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      overlay.classList.remove('myv-dragging-any');
      p.tile.classList.remove('myv-dragging');
      p.tile.style.transform = '';
      if (state.mode === 'grid' && dropTarget) {
        dropTarget.classList.remove('myv-drop-target');
        swapVideos(video.uid, dropTarget.dataset.uid);
      }
      if (state.mode === 'free') scheduleSave();
    };

    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  }

  function tileAtPoint(x, y, excludeUid) {
    for (const p of players.values()) {
      if (p.uid === excludeUid) continue;
      const r = p.tile.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p.tile;
    }
    return null;
  }

  function swapVideos(uidA, uidB) {
    const ia = state.videos.findIndex(v => v.uid === uidA);
    const ib = state.videos.findIndex(v => v.uid === uidB);
    if (ia === -1 || ib === -1) return;
    [state.videos[ia], state.videos[ib]] = [state.videos[ib], state.videos[ia]];
    applyOrder();
    scheduleSave();
  }

  function startResize(e, video, handleEl) {
    if (e.button !== 0 || state.mode !== 'free') return;
    e.preventDefault();
    e.stopPropagation();
    const p = players.get(video.uid);
    if (!p || !video.free) return;

    handleEl.setPointerCapture(e.pointerId);
    overlay.classList.add('myv-dragging-any');
    const startX = e.clientX, startY = e.clientY;
    const startW = video.free.w, startH = video.free.h;

    const onMove = (ev) => {
      video.free.w = Math.max(240, startW + (ev.clientX - startX));
      video.free.h = Math.max(150, startH + (ev.clientY - startY));
      p.tile.style.width = video.free.w + 'px';
      p.tile.style.height = video.free.h + 'px';
    };
    const onUp = () => {
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      overlay.classList.remove('myv-dragging-any');
      scheduleSave();
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  }

  // ---------- 构建覆盖层 DOM ----------
  function buildDom() {
    overlay = el('div', 'myv-overlay myv-hidden');

    const topbar = el('div', 'myv-topbar');
    const logo = el('div', 'myv-logo');
    logo.append(el('span', 'myv-logo-mark', '▶▶'), el('span', 'myv-logo-text', '多屏播放'));

    urlInput = document.createElement('input');
    urlInput.className = 'myv-input';
    urlInput.type = 'text';
    urlInput.placeholder = '粘贴链接添加…';
    urlInput.spellcheck = false;
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addFromInput();
      e.stopPropagation();
    });
    urlInput.addEventListener('paste', (e) => e.stopPropagation());

    hoverAudioBtn = btn('myv-btn myv-btn-wide', '🖱 悬停即听', '鼠标悬停哪个视频就听哪个的声音', () => {
      state.hoverAudio = !state.hoverAudio;
      updateHoverAudioBtn();
      toast(state.hoverAudio ? '悬停即听：开（移到哪个视频就听哪个）' : '悬停即听：关（点视频上的 🔇 选择）');
      scheduleSave();
    });

    const group1 = el('div', 'myv-group');
    group1.append(
      btn('myv-btn', '▶', '全部播放', () => { for (const p of players.values()) sendCommand(p, 'playVideo'); }),
      btn('myv-btn', '⏸', '全部暂停', () => { for (const p of players.values()) sendCommand(p, 'pauseVideo'); }),
      btn('myv-btn', '🔇', '静音全部', () => setAudioFocus(null)),
      hoverAudioBtn
    );

    modeBtn = btn('myv-btn myv-btn-wide', '⧉ 自由布局', '切换网格 / 自由布局', () => {
      setMode(state.mode === 'grid' ? 'free' : 'grid');
    });
    const group2 = el('div', 'myv-group');
    group2.append(modeBtn, btn('myv-btn', '⌫', '清空全部视频', () => {
      if (state.videos.length && confirm('确定移除所有视频？')) {
        for (const v of [...state.videos]) removeVideo(v.uid);
      }
    }));

    counterEl = el('span', 'myv-counter', '0 / 9');

    const winBtns = el('div', 'myv-group');
    winBtns.append(
      btn('myv-btn', '─', '最小化（后台继续播放）', minimize),
      btn('myv-btn myv-btn-x', '✕', '关闭（暂停全部）', close)
    );
    topbar.append(logo, urlInput, group1, group2, counterEl, winBtns);

    board = el('div', 'myv-board myv-grid-mode');
    emptyHint = el('div', 'myv-empty');
    const hintIcon = el('div', 'myv-empty-icon');
    for (let i = 0; i < 4; i++) hintIcon.append(el('span', null, '▶'));
    emptyHint.append(
      hintIcon,
      el('p', 'myv-empty-main', '悬停缩略图点「＋多屏」，或在观看页一键加入'),
      el('p', 'myv-empty-sub', '最多同时播放 9 个视频 · 拖动标题栏排列 · 鼠标悬停哪个就听哪个')
    );
    board.append(emptyHint);

    toastEl = el('div', 'myv-toast');
    overlay.append(topbar, board, toastEl);
    document.body.appendChild(overlay);
    updateHoverAudioBtn();

    window.addEventListener('message', onWindowMessage);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && visible) minimize();
    });
  }

  function updateHoverAudioBtn() {
    if (hoverAudioBtn) hoverAudioBtn.classList.toggle('myv-on', !!state.hoverAudio);
  }

  function addFromInput() {
    const text = urlInput.value.trim();
    if (!text) return;
    const ids = extractIds(text);
    if (!ids.length) { toast('没有识别到有效的 YouTube 链接'); return; }
    let added = 0;
    for (const id of ids) {
      if (!addVideo(id, { autoplay: visible })) break;
      added++;
    }
    if (added) urlInput.value = '';
    if (added > 1) toast(`已添加 ${added} 个视频`);
  }

  // ---------- 状态恢复与待添加队列 ----------
  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const saved = await store.get(STATE_KEY);
    if (saved && typeof saved.hoverAudio === 'boolean') state.hoverAudio = saved.hoverAudio;
    updateHoverAudioBtn();
    if (saved && Array.isArray(saved.videos)) {
      for (const v of saved.videos.slice(0, MAX_VIDEOS)) {
        if (!v || !ID_RE.test(v.id || '')) continue;
        // 恢复时不自动播放，避免多个视频同时响起
        const restored = addVideo(v.id, { autoplay: false, start: v.start || 0, save: false });
        if (restored && v.free) { restored.free = v.free; }
      }
      setMode(saved.mode === 'free' ? 'free' : 'grid');
    } else {
      setMode('grid');
    }
    refreshChrome();
    await consumePending();
  }

  function normalizePending(entry) {
    if (typeof entry === 'string') return { url: entry, start: 0, focus: false };
    return { url: entry.url, start: entry.start || 0, focus: !!entry.focus };
  }

  async function consumePending() {
    if (consumingPending || !loaded || !hasChromeStorage) return;
    if (document.visibilityState !== 'visible') return;
    consumingPending = true;
    try {
      const raw = (await store.get(PENDING_KEY)) || [];
      if (!raw.length) return;
      await store.set(PENDING_KEY, []);
      let added = 0;
      for (const entry of raw.map(normalizePending)) {
        const id = parseOne(entry.url || '');
        if (!id) continue;
        if (state.videos.some(v => v.id === id)) continue;
        if (addVideo(id, { autoplay: visible, start: entry.start, focus: entry.focus })) added++;
      }
      if (added && visible) toast(`已添加 ${added} 个视频`);
    } finally {
      consumingPending = false;
    }
  }

  if (hasChromeStorage) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[PENDING_KEY] &&
          Array.isArray(changes[PENDING_KEY].newValue) &&
          changes[PENDING_KEY].newValue.length > 0) {
        consumePending();
      }
    });
  }

  // ---------- 公开 API ----------
  function mount(options = {}) {
    if (mounted) return;
    opts = options;
    mounted = true;
    buildDom();
  }

  async function open() {
    if (!mounted) return;
    await ensureLoaded();
    visible = true;
    overlay.classList.remove('myv-hidden');
    document.documentElement.classList.add('myv-no-scroll');   // 锁定宿主页滚动
    if (state.mode === 'grid') applyGridTemplate();
    emitStatus();
  }

  function minimize() {
    visible = false;
    overlay.classList.add('myv-hidden');
    document.documentElement.classList.remove('myv-no-scroll');
    emitStatus();
  }

  function close() {
    for (const p of players.values()) sendCommand(p, 'pauseVideo');
    minimize();
  }

  function toggle() {
    if (visible) minimize();
    else open();
  }

  // 站内直接添加（观看页/悬停按钮走这里可以拿到同步反馈）
  async function requestAdd({ url, start = 0, focus = false }) {
    const id = parseOne(url || '');
    if (!id) return 'invalid';
    await ensureLoaded();
    if (state.videos.some(v => v.id === id)) return 'duplicate';
    if (state.videos.length >= MAX_VIDEOS) return 'full';
    addVideo(id, { autoplay: visible || focus, start, focus });
    return 'added';
  }

  function isVisible() { return visible; }
  function getCount() { return loaded ? state.videos.length : -1; }

  return { mount, open, minimize, close, toggle, requestAdd, isVisible, getCount };
})();
