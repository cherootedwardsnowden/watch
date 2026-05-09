window.addEventListener('lumen-ready', async () => {
  const t = window.LumenI18n.t;
  const u = window.LumenUtil;
  const api = window.LumenApi;

  const videoId = location.pathname.replace(/^\/watch\//, '').replace(/\/.*$/, '');
  if (!videoId) { location.href = '/'; return; }

  const player = document.getElementById('player');
  const titleEl = document.getElementById('videoTitle');
  const descEl = document.getElementById('videoDesc');
  const modeEl = document.getElementById('watchMode');
  const overlay = document.getElementById('playerOverlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayBody = document.getElementById('overlayBody');
  const bigPlay = document.getElementById('bigPlayBtn');
  const mask = document.getElementById('playerMask');

  player.controls = true;
  player.setAttribute('controlsList', 'nodownload noplaybackrate');
  player.setAttribute('disablepictureinpicture', '');

  let info;
  try {
    info = await api.post(`/api/videos/${videoId}/play`);
  } catch (e) {
    titleEl.textContent = t('watch_not_found_title', 'Video not found');
    descEl.textContent = t('watch_not_found_body', 'This video does not exist or has been removed.');
    return;
  }

  titleEl.textContent = info.title || '-';
  descEl.textContent = info.description || '';
  modeEl.textContent = info.mode === 'preview'
    ? t('watch_mode_preview', `Preview only - ${info.previewSeconds}s. Subscribe for full access.`).replace('${info.previewSeconds}', info.previewSeconds)
    : t('watch_mode_full', 'Full premium stream - private session');

  bigPlay.classList.add('show');
  mask.classList.add('show');

  function attach(srcUrl) {
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        maxBufferLength: 30,
        enableWorker: true,
        lowLatencyMode: false
      });
      hls.loadSource(srcUrl);
      hls.attachMedia(player);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          console.warn('[hls] fatal error', data.type, data.details);
        }
      });
      player.addEventListener('loadedmetadata', () => {
        try { player.removeAttribute('src'); } catch (e) {}
      }, { once: true });
    } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
      player.src = srcUrl;
    }
  }

  attach(info.playlistUrl);

  function start() {
    bigPlay.classList.remove('show');
    mask.classList.remove('show');
    player.play().catch(() => {});
  }
  bigPlay.addEventListener('click', start);
  player.addEventListener('play', () => {
    bigPlay.classList.remove('show');
    mask.classList.remove('show');
  });

  if (info.mode === 'preview') {
    const limit = info.previewSeconds || 15;
    let cutTriggered = false;
    function checkLimit() {
      if (player.currentTime >= limit && !cutTriggered) {
        cutTriggered = true;
        try { player.pause(); } catch (e) {}
        overlay.hidden = false;
      }
    }
    player.addEventListener('timeupdate', checkLimit);
  }

  player.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) e.preventDefault();
    if (e.key === 'F12') e.preventDefault();
  });

  setInterval(() => {
    if (player.src && player.src.includes('blob:') === false && player.tagName === 'VIDEO') {
      try {
        const a = player.getAttribute('src');
        if (a && a.startsWith('http')) player.removeAttribute('src');
      } catch (e) {}
    }
  }, 5000);
});
