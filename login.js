window.addEventListener('lumen-ready', () => {
  const form = document.getElementById('loginForm');
  const errBox = document.getElementById('loginError');
  const t = window.LumenI18n.t;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const fd = new FormData(form);
    const username = fd.get('username').trim();
    const password = fd.get('password');

    try {
      const r = await window.LumenApi.post('/api/login', { username, password });
      if (r.role === 'admin') {
        location.href = '/admin';
      } else {
        location.href = '/';
      }
    } catch (e) {
      const msg = e.body?.error === 'invalid_credentials'
        ? t('login_err_invalid', 'Invalid username or password.')
        : e.body?.error === 'rate_limited'
          ? t('login_err_rate', 'Too many attempts. Try again in a few minutes.')
          : t('login_err_generic', 'Could not sign you in.');
      errBox.textContent = msg;
      errBox.hidden = false;
    }
  });
});
