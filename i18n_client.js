window.LumenI18n = (function() {
  let dict = {};
  let lang = 'en';
  let supported = ['en'];
  const RTL = new Set(['ar', 'he', 'fa', 'ur']);
  const NAMES = {
    en: 'English', tr: 'Turkce', ru: 'Russkiy', ar: 'Arabiy',
    ja: 'Nihongo', es: 'Espanol', fr: 'Francais', de: 'Deutsch', zh: 'Zhongwen'
  };

  function applyDir() {
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  }

  function t(key, fb) {
    return (dict && dict[key]) || fb || key;
  }

  function applyDom(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const txt = t(key, el.textContent);
      el.textContent = txt;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = t(key, el.placeholder);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.title = t(key, el.title);
    });
    if (root === document) {
      const titleEl = document.querySelector('title[data-i18n]');
      if (titleEl) document.title = t(titleEl.getAttribute('data-i18n'), document.title);
    }
  }

  function buildSwitcher() {
    const sel = document.getElementById('langSwitcher');
    if (!sel) return;
    sel.innerHTML = '';
    for (const code of supported) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = NAMES[code] || code.toUpperCase();
      if (code === lang) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', async (e) => {
      const newLang = e.target.value;
      await fetch('/api/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: newLang }), credentials: 'include' });
      lang = newLang;
      const data = await (await fetch('/api/i18n', { credentials: 'include' })).json();
      dict = data.translations[lang] || data.translations.en || {};
      applyDir();
      applyDom();
      window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
    });
  }

  async function init() {
    try {
      const r = await fetch('/api/i18n', { credentials: 'include' });
      const data = await r.json();
      supported = data.supported || ['en'];
      lang = data.detected || 'en';
      dict = (data.translations && (data.translations[lang] || data.translations.en)) || {};
    } catch (e) {
      console.warn('[i18n] init failed', e);
    }
    applyDir();
    buildSwitcher();
    applyDom();
  }

  return {
    init, t, applyDom, get lang() { return lang; }
  };
})();
