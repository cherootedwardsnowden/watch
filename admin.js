window.addEventListener('lumen-ready', () => {
  const t = window.LumenI18n.t;
  const u = window.LumenUtil;
  const api = window.LumenApi;

  const adminApp = document.getElementById('adminApp');
  const adminLogin = document.getElementById('adminLogin');

  const me = window.LumenAuth.getUser();
  if (me && me.role === 'admin') {
    adminLogin.hidden = true;
    adminApp.hidden = false;
    bootAdmin();
  } else {
    adminLogin.hidden = false;
    adminApp.hidden = true;
    setupLogin();
  }

  function setupLogin() {
    const form = document.getElementById('adminLoginForm');
    const errBox = document.getElementById('adminLoginError');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const fd = new FormData(form);
      try {
        const r = await api.post('/api/login', { username: fd.get('username').trim(), password: fd.get('password') });
        if (r.role !== 'admin') throw new Error('not_admin');
        location.reload();
      } catch (e) {
        errBox.textContent = t('admin_login_err', 'Invalid admin credentials.');
        errBox.hidden = false;
      }
    });
  }

  function bootAdmin() {
    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(x => x.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-tab');
        document.querySelectorAll('.admin-pane').forEach(p => p.hidden = (p.getAttribute('data-pane') !== target));
        if (target === 'videos') loadVideos();
        if (target === 'payments') loadPayments();
        if (target === 'users') loadUsers();
        if (target === 'dashboard') loadStats();
        if (target === 'upload') loadUploads();
      });
    });

    loadStats();
    setupUpload();
    resumePendingUploads();
  }

  async function loadStats() {
    try {
      const r = await api.get('/api/admin/stats');
      const s = r.stats || {};
      const grid = document.getElementById('statGrid');
      grid.innerHTML = '';
      const items = [
        ['stat_total_users', 'Users', s.totalUsers],
        ['stat_active_subs', 'Active subscribers', s.activeSubscribers],
        ['stat_total_payments', 'Payments total', s.totalPayments],
        ['stat_paid', 'Paid', s.paidPayments],
        ['stat_pending', 'Pending', s.pendingPayments],
        ['stat_failed', 'Failed/Expired', s.failedPayments],
        ['stat_videos', 'Videos', s.totalVideos],
        ['stat_videos_ready', 'Ready', s.readyVideos],
        ['stat_videos_proc', 'Processing', s.processingVideos]
      ];
      for (const [key, fb, val] of items) {
        grid.appendChild(u.el('div', { class: 'stat-card' }, [
          u.el('div', { class: 'stat-label' }, t(key, fb)),
          u.el('div', { class: 'stat-value' }, String(val ?? 0))
        ]));
      }
    } catch (e) {}
  }

  async function loadVideos() {
    const tbody = document.querySelector('#videosTable tbody');
    tbody.innerHTML = '';
    try {
      const r = await api.get('/api/admin/videos');
      for (const v of r.videos) {
        tbody.appendChild(u.el('tr', null, [
          u.el('td', null, v.status === 'ready' ? u.el('img', { src: `/thumbs/${v.id}/thumb.jpg`, alt: '' }) : ''),
          u.el('td', null, v.title || '-'),
          u.el('td', null, u.el('span', { class: `badge ${v.status}` }, v.status)),
          u.el('td', null, u.fmtDuration(v.duration)),
          u.el('td', null, v.width ? `${v.width}x${v.height}` : '-'),
          u.el('td', null, u.fmtDate(v.createdAt)),
          u.el('td', null, [
            u.el('button', { class: 'btn btn-ghost', style: { padding: '6px 10px', fontSize: '12px' }, onclick: () => location.href = `/watch/${v.id}` }, t('action_play', 'Play')),
            ' ',
            u.el('button', { class: 'btn btn-ghost', style: { padding: '6px 10px', fontSize: '12px' }, onclick: () => deleteVideo(v.id) }, t('action_delete', 'Delete'))
          ])
        ]));
      }
      if (!r.videos.length) {
        tbody.appendChild(u.el('tr', null, u.el('td', { colspan: 7, style: { color: 'var(--text-muted)', textAlign: 'center', padding: '24px' } }, t('admin_no_videos', 'No videos yet.'))));
      }
    } catch (e) {}
  }

  async function deleteVideo(id) {
    if (!confirm(t('confirm_delete_video', 'Delete this video permanently?'))) return;
    try { await api.del(`/api/admin/videos/${id}`); loadVideos(); loadStats(); } catch (e) {}
  }

  let paymentFilter = 'all';
  document.querySelectorAll('[data-filter]').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      paymentFilter = c.getAttribute('data-filter');
      loadPayments();
    });
  });

  async function loadPayments() {
    const tbody = document.querySelector('#paymentsTable tbody');
    tbody.innerHTML = '';
    try {
      const r = await api.get('/api/admin/payments');
      let list = r.payments;
      if (paymentFilter !== 'all') list = list.filter(p => p.status === paymentFilter);
      for (const p of list) {
        tbody.appendChild(u.el('tr', null, [
          u.el('td', null, p.email),
          u.el('td', null, u.el('span', { class: `badge ${p.status}` }, p.status)),
          u.el('td', null, p.payAmount ? `${p.payAmount}` : '-'),
          u.el('td', null, (p.payCurrency || '').toUpperCase() || '-'),
          u.el('td', null, u.fmtDate(p.createdAt)),
          u.el('td', null, p.slug ? u.el('a', { href: `/pay/${p.slug}`, target: '_blank', style: { color: 'var(--accent-2)', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' } }, p.slug.slice(0, 28) + '...') : '-')
        ]));
      }
      if (!list.length) {
        tbody.appendChild(u.el('tr', null, u.el('td', { colspan: 6, style: { color: 'var(--text-muted)', textAlign: 'center', padding: '24px' } }, t('admin_no_payments', 'No payments match this filter.'))));
      }
    } catch (e) {}
  }

  async function loadUsers() {
    const tbody = document.querySelector('#usersTable tbody');
    tbody.innerHTML = '';
    try {
      const r = await api.get('/api/admin/users');
      for (const us of r.users) {
        tbody.appendChild(u.el('tr', null, [
          u.el('td', { class: 'mono' }, us.username),
          u.el('td', null, us.email),
          u.el('td', null, u.el('span', { class: `badge ${us.active ? 'paid' : 'expired'}` }, us.active ? 'active' : 'expired')),
          u.el('td', null, u.fmtDate(us.subscriptionExpiresAt)),
          u.el('td', null, u.fmtDate(us.createdAt))
        ]));
      }
      if (!r.users.length) {
        tbody.appendChild(u.el('tr', null, u.el('td', { colspan: 5, style: { color: 'var(--text-muted)', textAlign: 'center', padding: '24px' } }, t('admin_no_users', 'No users yet.'))));
      }
    } catch (e) {}
  }

  function setupUpload() {
    const form = document.getElementById('uploadForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const file = fd.get('file');
      const title = fd.get('title') || file.name;
      const description = fd.get('description') || '';
      if (!file || !file.size) return;
      await startUpload(file, title, description);
      form.reset();
    });
  }

  async function loadUploads() {
    try {
      const r = await api.get('/api/admin/uploads');
      const local = JSON.parse(localStorage.getItem('lumen.uploads') || '{}');
      const list = document.getElementById('uploadList');
      list.innerHTML = '';
      const map = {};
      for (const up of r.uploads) map[up.id] = up;
      for (const up of r.uploads.slice(0, 30)) {
        const row = u.el('div', { class: 'upload-item' }, [
          u.el('div', { class: 'name' }, up.fileName),
          u.el('div', { class: 'meta' }, [
            u.el('span', { class: `badge ${up.status}` }, up.status),
            u.el('span', null, `${(up.receivedChunks || []).length} / ${up.totalChunks}`)
          ]),
          u.el('div', { class: 'progress' }, u.el('div', { style: { width: `${((up.receivedChunks || []).length / up.totalChunks * 100).toFixed(1)}%` } }))
        ]);
        list.appendChild(row);
      }
    } catch (e) {}
  }

  const CHUNK_SIZE = 10 * 1024 * 1024;
  const PARALLEL = 4;

  async function startUpload(file, title, description) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const init = await api.post('/api/admin/upload/init', {
      fileName: file.name, fileSize: file.size, totalChunks, title, description
    });
    const uploadId = init.uploadId;

    const local = JSON.parse(localStorage.getItem('lumen.uploads') || '{}');
    local[uploadId] = { fileName: file.name, fileSize: file.size, totalChunks, title, description, started: Date.now() };
    localStorage.setItem('lumen.uploads', JSON.stringify(local));

    await runUpload(uploadId, file, totalChunks);
  }

  async function uploadOneChunk(uploadId, file, i) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);
    const fd = new FormData();
    fd.append('chunk', blob, `chunk_${i}`);
    let attempts = 0;
    while (true) {
      try {
        const r = await fetch(`/api/admin/upload/${uploadId}/chunk/${i}`, { method: 'POST', body: fd, credentials: 'include' });
        if (!r.ok) throw new Error('bad_status_' + r.status);
        return;
      } catch (e) {
        attempts++;
        if (attempts > 6) throw e;
        await new Promise(r => setTimeout(r, 1000 * attempts));
      }
    }
  }

  async function runUpload(uploadId, file, totalChunks) {
    const list = document.getElementById('uploadList');
    const row = u.el('div', { class: 'upload-item', id: `upl_${uploadId}` }, [
      u.el('div', { class: 'name' }, file.name),
      u.el('div', { class: 'meta' }, [
        u.el('span', { class: 'badge uploading' }, 'uploading'),
        u.el('span', { id: `prog_text_${uploadId}` }, `0 / ${totalChunks}`)
      ]),
      u.el('div', { class: 'progress' }, u.el('div', { id: `prog_bar_${uploadId}`, style: { width: '0%' } }))
    ]);
    list.prepend(row);

    let state;
    try {
      const s = await api.get(`/api/admin/upload/${uploadId}/state`);
      state = s.upload;
    } catch (e) { state = null; }
    const received = new Set((state?.receivedChunks) || []);

    const queue = [];
    for (let i = 0; i < totalChunks; i++) if (!received.has(i)) queue.push(i);

    function updateProgress() {
      const pct = ((received.size / totalChunks) * 100).toFixed(1);
      const tEl = document.getElementById(`prog_text_${uploadId}`);
      const bEl = document.getElementById(`prog_bar_${uploadId}`);
      if (tEl) tEl.textContent = `${received.size} / ${totalChunks}`;
      if (bEl) bEl.style.width = `${pct}%`;
    }
    updateProgress();

    let cursor = 0;
    let failed = false;
    async function worker() {
      while (!failed) {
        const my = cursor++;
        if (my >= queue.length) return;
        const idx = queue[my];
        try {
          await uploadOneChunk(uploadId, file, idx);
          received.add(idx);
          updateProgress();
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    }
    const workers = [];
    for (let w = 0; w < Math.min(PARALLEL, queue.length); w++) workers.push(worker());
    try {
      await Promise.all(workers);
    } catch (e) {
      const badge = row.querySelector('.badge');
      if (badge) { badge.className = 'badge failed'; badge.textContent = 'upload failed'; }
      return;
    }

    try {
      await api.post(`/api/admin/upload/${uploadId}/complete`, {});
      const local = JSON.parse(localStorage.getItem('lumen.uploads') || '{}');
      delete local[uploadId];
      localStorage.setItem('lumen.uploads', JSON.stringify(local));
      const badge = row.querySelector('.badge');
      if (badge) { badge.className = 'badge processing'; badge.textContent = 'processing'; }
      loadVideos();
      loadStats();
    } catch (e) {
      const badge = row.querySelector('.badge');
      if (badge) { badge.className = 'badge failed'; badge.textContent = 'failed'; }
    }
  }

  async function resumePendingUploads() {
    const local = JSON.parse(localStorage.getItem('lumen.uploads') || '{}');
    const ids = Object.keys(local);
    if (!ids.length) return;
    const note = document.createElement('div');
    note.className = 'muted';
    note.style.marginTop = '12px';
    note.textContent = t('admin_resume_note', `Found ${ids.length} interrupted upload(s). Use the Upload tab to re-select the same file to continue.`);
  }
});
