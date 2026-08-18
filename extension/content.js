// youtube.com 站内集成：
// - 右下角悬浮舱（打开多屏覆盖层 + 数量角标 + 播放中指示）
// - 观看页「把当前视频放入多屏」：带走当前播放进度，页面视频自动暂停
// - 悬停缩略图「＋多屏」按钮
// 多屏本体由 multiview.js 以覆盖层形式渲染在本页内，全程不离开 YouTube。
// 依赖 common.js + multiview.js（按 manifest 顺序先行加载）。

'use strict';

(function () {
  if (window.top !== window) return;   // 只在顶层页面注入

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function send(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        if (cb) cb(resp);
      });
    } catch { /* extension context invalidated */ }
  }

  const FEEDBACK = {
    added: '✓ 已加入多屏',
    duplicate: '已在多屏中',
    full: `多屏已满 ${MAX_VIDEOS} 个`,
    invalid: '无法识别视频'
  };

  function flashText(btn, text) {
    if (!btn.dataset.myvLabel) btn.dataset.myvLabel = btn.textContent;
    btn.textContent = text;
    btn.classList.add('myv-flash');
    clearTimeout(btn._myvTimer);
    btn._myvTimer = setTimeout(() => {
      btn.textContent = btn.dataset.myvLabel;
      btn.classList.remove('myv-flash');
    }, 1400);
  }

  // ---------- 多屏引擎挂载 ----------
  let engineStatus = { count: -1, playing: false, visible: false };
  MultiView.mount({
    onStatus(s) {
      engineStatus = s;
      renderDock();
    }
  });

  // ---------- 右下角悬浮舱 ----------
  const dock = el('button', null, null);
  dock.id = 'myv-dock';
  dock.title = '打开多屏播放（当前页内）';
  const dockMark = el('span', 'myv-dock-mark', '▶▶');
  const dockEq = el('span', 'myv-dock-eq');
  for (let i = 0; i < 3; i++) dockEq.append(el('i'));
  const dockCount = el('span', 'myv-dock-count', '0');
  dock.append(dockMark, dockEq, dockCount);
  dock.addEventListener('click', () => MultiView.toggle());

  const watchPill = el('button', null, '⧉ 把当前视频放入多屏');
  watchPill.id = 'myv-watch-pill';
  watchPill.addEventListener('click', async () => {
    const url = location.href;
    const pageVideo = document.querySelector('video.html5-main-video, video');
    const start = pageVideo && !isNaN(pageVideo.currentTime) ? pageVideo.currentTime : 0;
    const status = await MultiView.requestAdd({ url, start, focus: true });
    if (status === 'added') {
      if (pageVideo) pageVideo.pause();   // 交接给多屏，页面视频停下
      MultiView.open();
    } else {
      flashText(watchPill, FEEDBACK[status] || '出错了');
    }
  });

  const cluster = el('div', null);
  cluster.id = 'myv-cluster';
  cluster.append(watchPill, dock);

  let bgCount = 0;
  function refreshBgCount() {
    send({ type: 'myv-count' }, (resp) => {
      if (resp && typeof resp.count === 'number') {
        bgCount = resp.count;
        renderDock();
      }
    });
  }

  function renderDock() {
    // 引擎未加载（本页还没打开过多屏）时显示全局计数，加载后显示引擎实时计数
    const count = engineStatus.count >= 0 ? engineStatus.count : bgCount;
    dockCount.textContent = count;
    dock.classList.toggle('myv-has-videos', count > 0);
    dock.classList.toggle('myv-playing', engineStatus.playing && !engineStatus.visible);
    cluster.style.display =
      engineStatus.visible || document.fullscreenElement ? 'none' : '';
  }

  function updateWatchPill() {
    watchPill.style.display = parseOne(location.href) ? '' : 'none';
  }

  // ---------- 缩略图悬停按钮 ----------
  const hoverBtn = el('button', null, '＋ 多屏');
  hoverBtn.id = 'myv-hover-btn';
  hoverBtn.style.display = 'none';
  let hoverLink = null;

  hoverBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hoverLink) return;
    const status = await MultiView.requestAdd({ url: hoverLink.href });
    flashText(hoverBtn, FEEDBACK[status] || '出错了');
  });

  function isThumbLink(a) {
    if (!a.href) return false;
    const path = a.pathname || '';
    if (!(path === '/watch' || path.startsWith('/shorts/') || path.startsWith('/live/'))) return false;
    if (!parseOne(a.href)) return false;
    return !!(a.id === 'thumbnail' || a.querySelector('yt-image, img') || a.closest('ytd-thumbnail'));
  }

  function showHoverBtn(link) {
    const rect = link.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 56) return;
    hoverLink = link;
    hoverBtn.style.display = '';
    hoverBtn.style.left = Math.round(rect.left + 6) + 'px';
    hoverBtn.style.top = Math.round(rect.top + 6) + 'px';
  }

  function hideHoverBtn() {
    hoverLink = null;
    hoverBtn.style.display = 'none';
    if (hoverBtn.dataset.myvLabel) hoverBtn.textContent = hoverBtn.dataset.myvLabel;
    hoverBtn.classList.remove('myv-flash');
  }

  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (t === hoverBtn || hoverBtn.contains(t)) return;
    const link = t.closest ? t.closest('a') : null;
    if (link && isThumbLink(link)) showHoverBtn(link);
    else if (hoverLink && !hoverLink.contains(t)) hideHoverBtn();
  }, true);

  document.addEventListener('scroll', hideHoverBtn, { capture: true, passive: true });
  document.addEventListener('fullscreenchange', () => { renderDock(); hideHoverBtn(); });

  // ---------- 消息与导航 ----------
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'myv-toggle-overlay') MultiView.toggle();
      if (msg.type === 'myv-open-overlay') MultiView.open();
    });
  }

  window.addEventListener('yt-navigate-finish', () => { updateWatchPill(); hideHoverBtn(); });
  window.addEventListener('popstate', updateWatchPill);

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.myv_state || changes.myv_pending)) refreshBgCount();
    });
  }

  // ---------- 启动 ----------
  function boot() {
    // 版本自报：排查问题时用来确认页面里跑的是哪个版本的脚本
    try {
      console.info(`[MultiView] v${chrome.runtime.getManifest().version} 已加载（Referer 改写方案）`);
    } catch { /* stale context */ }
    document.body.append(cluster, hoverBtn);
    updateWatchPill();
    refreshBgCount();
    // 工具栏图标在非 YouTube 页面被点击 → background 新开本页并留下标记，此处自动展开多屏
    try {
      chrome.storage.local.get('myv_autoopen', ({ myv_autoopen }) => {
        void chrome.runtime.lastError;
        if (myv_autoopen && Date.now() - myv_autoopen < 30000) {
          chrome.storage.local.remove('myv_autoopen');
          MultiView.open();
        }
      });
    } catch { /* extension context invalidated */ }
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
