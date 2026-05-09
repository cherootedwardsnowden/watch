window.addEventListener('lumen-ready', async () => {
  const grid = document.getElementById('videoGrid');
  const empty = document.getElementById('emptyState');
  const t = window.LumenI18n.t;
  const u = window.LumenUtil;

  try {
    const data = await window.LumenApi.get('/api/videos');
    const videos = data.videos || [];
    if (!videos.length) {
      empty.hidden = false;
      return;
    }
    grid.innerHTML = '';
    for (const v of videos) {
      const card = u.el('div', { class: 'card', onclick: () => location.href = `/watch/${v.id}` }, [
        u.el('div', { class: 'card-thumb' }, [
          u.el('img', { src: v.thumb, alt: v.title || '', loading: 'lazy' }),
          u.el('span', { class: 'card-duration' }, u.fmtDuration(v.duration))
        ]),
        u.el('div', { class: 'card-body' }, [
          u.el('h3', { class: 'card-title' }, v.title || 'Untitled'),
          u.el('div', { class: 'card-meta' }, u.fmtDate(v.readyAt || v.createdAt))
        ])
      ]);
      grid.appendChild(card);
    }
  } catch (e) {
    grid.innerHTML = '';
    empty.hidden = false;
  }
});
