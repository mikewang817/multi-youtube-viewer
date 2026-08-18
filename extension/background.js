// Service worker：右键菜单、站内添加请求处理、打开/聚焦多屏覆盖层
// 多屏只存在于 youtube.com 页内（chrome-extension:// 页面缺少嵌入方身份，会被 YouTube 以 153 拒绝）

importScripts('common.js');

const YT_LINK_PATTERNS = [
  '*://www.youtube.com/watch*',
  '*://youtube.com/watch*',
  '*://m.youtube.com/watch*',
  '*://www.youtube.com/shorts/*',
  '*://youtube.com/shorts/*',
  '*://www.youtube.com/live/*',
  '*://youtu.be/*'
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'myv-add-link',
      title: '添加到多屏播放',
      contexts: ['link'],
      targetUrlPatterns: YT_LINK_PATTERNS
    });
    chrome.contextMenus.create({
      id: 'myv-add-page',
      title: '添加当前视频到多屏播放',
      contexts: ['page'],
      documentUrlPatterns: YT_LINK_PATTERNS
    });
  });
});

// 统一的添加入口：解析 → 去重 → 上限检查 → 写入待添加队列
// （播放页打开时会通过 storage.onChanged 立即消费队列）
async function handleAdd(url) {
  const id = parseOne(url || '');
  if (!id) return { status: 'invalid', count: await getCount() };

  const data = await chrome.storage.local.get(['myv_state', 'myv_pending']);
  const stateIds = ((data.myv_state && data.myv_state.videos) || []).map(v => v.id);
  const pending = data.myv_pending || [];
  const pendingIds = pending.map(parseOne).filter(Boolean);
  const count = stateIds.length + pendingIds.length;

  if (stateIds.includes(id) || pendingIds.includes(id)) {
    return { status: 'duplicate', count };
  }
  if (count >= MAX_VIDEOS) {
    return { status: 'full', count };
  }
  pending.push(url);
  await chrome.storage.local.set({ myv_pending: pending });
  return { status: 'added', count: count + 1 };
}

async function getCount() {
  const data = await chrome.storage.local.get(['myv_state', 'myv_pending']);
  const stateIds = ((data.myv_state && data.myv_state.videos) || []).map(v => v.id);
  const pendingIds = (data.myv_pending || []).map(parseOne).filter(Boolean)
    .filter(id => !stateIds.includes(id));
  return stateIds.length + pendingIds.length;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'myv-add') {
    handleAdd(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === 'myv-count') {
    getCount().then(count => sendResponse({ count }));
    return true;
  }
  if (msg.type === 'myv-open') {
    openPlayer().then(() => sendResponse({ ok: true }));
    return true;
  }
});

const YT_PAGE_RE = /^https?:\/\/(www|m)\.youtube\.com\//;

// 当前标签是 YouTube → 直接在页内打开覆盖层；
// 否则 → 聚焦已有的 YouTube 标签页并打开覆盖层；一个都没有就新开一个并自动展开。
async function openMultiView(tab, msgType) {
  if (tab && tab.id != null && tab.url && YT_PAGE_RE.test(tab.url)) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: msgType });
      return;
    } catch { /* content script 未注入（安装前就开着的旧标签页），走下面的通用路径 */ }
  }
  const ytTabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://m.youtube.com/*'] });
  for (const t of ytTabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: 'myv-open-overlay' });
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return;
    } catch { /* 这个标签页没有 content script，试下一个 */ }
  }
  // 没有可用的 YouTube 标签页：新开一个，content script 启动时读到标记后自动展开覆盖层
  await chrome.storage.local.set({ myv_autoopen: Date.now() });
  await chrome.tabs.create({ url: 'https://www.youtube.com/' });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'myv-add-link' ? info.linkUrl : info.pageUrl;
  if (!url) return;
  await handleAdd(url);
  await openMultiView(tab, 'myv-open-overlay');
});

chrome.action.onClicked.addListener((tab) => {
  openMultiView(tab, 'myv-toggle-overlay');
});
