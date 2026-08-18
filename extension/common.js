// 三个运行环境共用的常量与纯函数：
// background.js 用 importScripts 加载；player.html / content_scripts 作为前置 <script> 加载。

'use strict';

const MAX_VIDEOS = 9;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseOne(token) {
  if (ID_RE.test(token)) return token;
  let u;
  try { u = new URL(token); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
    if (m) return m[1];
  }
  return null;
}

function extractIds(text) {
  const ids = [];
  for (const token of text.split(/[\s,，]+/).filter(Boolean)) {
    const id = parseOne(token);
    if (id) ids.push(id);
  }
  return ids;
}
