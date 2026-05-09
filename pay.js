window.addEventListener('lumen-ready', async () => {
  const t = window.LumenI18n.t;
  const u = window.LumenUtil;

  const slug = location.pathname.replace(/^\/pay\//, '').replace(/\/$/, '');
  if (!slug) { showError('not_found', t('pay_err_not_found', 'Invalid payment link.')); return; }

  const stages = {
    error: document.getElementById('stageError'),
    select: document.getElementById('stageSelect'),
    invoice: document.getElementById('stageInvoice'),
    paid: document.getElementById('stagePaid'),
    expired: document.getElementById('stageExpired')
  };
  function show(name) {
    for (const k in stages) stages[k].hidden = (k !== name);
  }
  function showError(code, msg) {
    show('error');
    document.getElementById('errorMessage').textContent = msg;
  }

  let info = null;
  try {
    const r = await window.LumenApi.get(`/api/pay/${slug}/info`);
    info = r;
  } catch (e) {
    if (e.status === 403) return showError('ip', t('pay_err_ip', 'This link is locked to a different IP. Please start over from the same network.'));
    if (e.status === 404) return showError('notfound', t('pay_err_not_found', 'Invalid or unknown payment link.'));
    return showError('generic', t('pay_err_generic', 'Could not load this payment session.'));
  }

  document.getElementById('priceUsd').textContent = info.priceUsd || 5;
  document.getElementById('payEmail').textContent = info.email;

  if (info.status === 'paid') return show('paid');
  if (info.status === 'expired' || info.status === 'failed') return show('expired');
  if (info.status === 'awaiting_payment' && info.payAddress) {
    enterInvoiceStage({
      payAmount: info.payAmount,
      payCurrency: info.payCurrency,
      payAddress: info.payAddress,
      expiresAt: info.expiresAt,
      network: null,
      payinExtraId: null
    });
    startPolling();
    return;
  }

  show('select');

  const sel = document.getElementById('currencySelect');
  const createBtn = document.getElementById('createBtn');
  const estBox = document.getElementById('estimateBox');
  const estAmount = document.getElementById('estAmount');
  const estCurrency = document.getElementById('estCurrency');

  let lastEstimate = null;

  try { await loadCurrencies(); }
  catch (e) {
    console.error('[pay] loadCurrencies threw:', e);
    sel.innerHTML = '';
    sel.appendChild(u.el('option', { value: '' }, t('pay_load_currencies_fail', 'Could not load currencies')));
  }

  sel.addEventListener('change', async () => {
    const c = sel.value;
    if (!c) { estBox.hidden = true; createBtn.disabled = true; return; }
    estBox.hidden = false;
    estAmount.textContent = '...';
    estCurrency.textContent = c.toUpperCase();
    try {
      const r = await window.LumenApi.post(`/api/pay/${slug}/estimate`, { currency: c });
      lastEstimate = r;
      const amt = r.estimated_amount || r.pay_amount || 0;
      estAmount.textContent = Number(amt).toFixed(8).replace(/\.?0+$/, '');
      createBtn.disabled = false;
    } catch (e) {
      lastEstimate = null;
      estAmount.textContent = '?';
      estCurrency.textContent = '';
      createBtn.disabled = true;
    }
  });

  createBtn.addEventListener('click', async () => {
    const c = sel.value;
    if (!c) return;
    createBtn.disabled = true;
    document.getElementById('createError').hidden = true;
    try {
      const r = await window.LumenApi.post(`/api/pay/${slug}/create`, { currency: c });
      enterInvoiceStage(r);
      startPolling();
    } catch (e) {
      const errBox = document.getElementById('createError');
      errBox.textContent = e.body?.error === 'nowpayments_not_configured'
        ? t('pay_err_no_provider', 'Payment provider not configured. Contact admin.')
        : t('pay_err_create_failed', 'Could not create address. Try a different coin.');
      errBox.hidden = false;
      createBtn.disabled = false;
    }
  });

  async function loadCurrencies() {
    const popular = ['btc', 'eth', 'usdttrc20', 'usdterc20', 'usdtbsc', 'ltc', 'doge', 'sol', 'xmr', 'bnbbsc', 'trx', 'matic', 'ada', 'bch', 'dot'];
    let list = [];
    try {
      const r = await window.LumenApi.get('/api/payment/currencies');
      if (r && Array.isArray(r.currencies)) list = r.currencies.map(c => String(c).toLowerCase());
    } catch (e) {
      console.warn('[pay] currencies api failed:', e.message);
    }
    if (!list.length) list = popular;
    sel.innerHTML = '';
    sel.appendChild(u.el('option', { value: '' }, t('pay_select_placeholder', 'Select a coin / network')));
    const popularSet = new Set(popular);
    const inList = new Set(list);
    const ordered = [...popular.filter(p => inList.has(p)), ...list.filter(c => !popularSet.has(c))];
    const seen = new Set();
    for (const code of ordered) {
      if (seen.has(code)) continue;
      seen.add(code);
      sel.appendChild(u.el('option', { value: code }, code.toUpperCase()));
    }
  }

  function enterInvoiceStage(d) {
    show('invoice');
    document.getElementById('invAmount').textContent = String(d.payAmount);
    document.getElementById('invCurrency').textContent = (d.payCurrency || '').toUpperCase();
    document.getElementById('invAddress').textContent = d.payAddress;
    document.getElementById('invNetwork').textContent = d.network || (d.payCurrency || '').toUpperCase();
    if (d.payinExtraId) {
      document.getElementById('invExtraRow').hidden = false;
      document.getElementById('invExtra').textContent = d.payinExtraId;
    }
    startCountdown(d.expiresAt);
  }

  let countdownTimer = null;
  function startCountdown(expiresAt) {
    if (countdownTimer) clearInterval(countdownTimer);
    const total = expiresAt - Date.now();
    function tick() {
      const remaining = expiresAt - Date.now();
      const txt = document.getElementById('countdownText');
      const fill = document.getElementById('countdownFill');
      if (remaining <= 0) {
        txt.textContent = '00:00';
        fill.style.width = '0%';
        clearInterval(countdownTimer);
        return;
      }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      txt.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      fill.style.width = `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`;
    }
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  let pollTimer = null;
  async function pollOnce() {
    try {
      const r = await window.LumenApi.get(`/api/pay/${slug}/status`);
      const status = r.status;
      const statusEl = document.getElementById('statusText');
      if (status === 'paid') {
        clearInterval(pollTimer); clearInterval(countdownTimer);
        show('paid');
        return;
      }
      if (status === 'expired') {
        clearInterval(pollTimer); clearInterval(countdownTimer);
        show('expired');
        return;
      }
      if (status === 'failed') {
        clearInterval(pollTimer); clearInterval(countdownTimer);
        show('expired');
        return;
      }
      if (r.remoteStatus === 'confirming' || r.remoteStatus === 'partially_paid') {
        statusEl.textContent = t('pay_status_confirming', 'Transaction detected, confirming...');
      }
    } catch (e) {}
  }
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollOnce();
    pollTimer = setInterval(pollOnce, 10 * 1000);
  }
});
