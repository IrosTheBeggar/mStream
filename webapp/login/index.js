document.getElementById("login").addEventListener("submit", async e => {
  e.preventDefault();

  // Lock Button
  document.getElementById("form-submit").disabled = true;

  try {
    const res = await axios({
      method: 'POST',
      url: `${API.url()}/api/v1/auth/login`,
      data: {
        username: document.getElementById('email').value,
        password: document.getElementById('password').value
      }
    });

    localStorage.setItem("token", res.data.token);

    // Where to land after successful auth depends on which URL served
    // the login page:
    //   /mstream-login  → always the admin flow (Refix/Velvet can't
    //                     reach /admin directly, so operators always
    //                     come through this path). Land on /admin.
    //   /login          → legacy default-UI bookmark; preserve the
    //                     pre-existing "strip /login from the URL"
    //                     behaviour so query-string state survives.
    if (window.location.pathname.startsWith('/mstream-login')) {
      window.location.assign('/admin');
    } else {
      window.location.assign(window.location.href.replace('/login', ''));
    }

    iziToast.success({
      title: t('login.success'),
      position: 'topCenter',
      timeout: 3500
    });
  } catch (err) {
    iziToast.error({
      title: t('login.failed'),
      position: 'topCenter',
      timeout: 3500
    });
  }

  document.getElementById("form-submit").disabled = false;
});