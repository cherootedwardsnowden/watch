window.addEventListener('lumen-ready', () => {
  const form = document.getElementById('registerForm');
  const errBox = document.getElementById('registerError');
  const t = window.LumenI18n.t;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const fd = new FormData(form);
    const email = (fd.get('email') || '').toString().trim();
    if (!email) return;
    try {
      const r = await window.LumenApi.post('/api/register', { email });
      location.href = r.url;
    } catch (e) {
      const msg = e.body?.error === 'invalid_email'
        ? t('register_err_email', 'Please enter a valid email address.')
        : t('register_err_generic', 'Could not create checkout. Try again.');
      errBox.textContent = msg;
      errBox.hidden = false;
    }
  });
});
