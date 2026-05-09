window.LumenAuth = (function() {
  let me = null;

  function role() {
    if (!me) return 'anon';
    if (me.role === 'admin') return 'admin';
    return me.subscriptionActive ? 'subscriber' : 'user-no-sub';
  }

  function applyVisibility() {
    document.querySelectorAll('[data-auth-show]').forEach(el => {
      const want = el.getAttribute('data-auth-show');
      const current = role();
      let show = false;
      if (want === 'anon') show = !me;
      else if (want === 'auth') show = !!me;
      else if (want === 'user') show = !!me && me.role !== 'admin';
      else if (want === 'admin') show = me && me.role === 'admin';
      else if (want === 'subscriber') show = me && (me.role === 'admin' || me.subscriptionActive);
      else if (want === 'user-no-sub') show = me && me.role !== 'admin' && !me.subscriptionActive;
      el.hidden = !show;
    });
    document.querySelectorAll('[data-auth-username]').forEach(el => {
      el.textContent = me ? (me.username || me.email || '') : '';
    });
  }

  async function load() {
    try {
      const r = await fetch('/api/me', { credentials: 'include' });
      const data = await r.json();
      me = data.user || null;
    } catch (e) { me = null; }
    applyVisibility();
    return me;
  }

  function getUser() { return me; }

  async function logout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    me = null;
    location.href = '/';
  }

  return { load, getUser, applyVisibility, logout };
})();

window.LumenApi = {
  async get(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw await wrapErr(r);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw await wrapErr(r);
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw await wrapErr(r);
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw await wrapErr(r);
    return r.json();
  }
};

async function wrapErr(r) {
  let body = null;
  try { body = await r.json(); } catch (e) {}
  const e = new Error((body && (body.error || body.detail)) || `HTTP ${r.status}`);
  e.status = r.status;
  e.body = body;
  return e;
}

window.LumenUtil = {
  fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return `${h}:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  },
  fmtDate(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  },
  fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
  },
  copy(text) {
    if (navigator.clipboard) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    return Promise.resolve();
  },
  el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'style') Object.assign(e.style, attrs[k]);
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === false || attrs[k] == null) {}
      else if (attrs[k] === true) e.setAttribute(k, '');
      else e.setAttribute(k, attrs[k]);
    }
    if (children) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null || c === false) continue;
        if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
        else e.appendChild(c);
      }
    }
    return e;
  }
};

(async function bootstrap() {
  if (window.LumenI18n && window.LumenI18n.init) await window.LumenI18n.init();
  await window.LumenAuth.load();

  const lo = document.getElementById('logoutBtn');
  if (lo) lo.addEventListener('click', () => window.LumenAuth.logout());

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const id = btn.getAttribute('data-copy');
    const elv = document.getElementById(id);
    if (!elv) return;
    window.LumenUtil.copy(elv.textContent.trim()).then(() => {
      btn.classList.add('copied');
      const orig = btn.textContent;
      btn.textContent = window.LumenI18n.t('copied', 'Copied');
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1500);
    });
  });

  document.addEventListener('contextmenu', (e) => {
    if (e.target.tagName === 'VIDEO') e.preventDefault();
  });

  window.dispatchEvent(new CustomEvent('lumen-ready'));
})();
