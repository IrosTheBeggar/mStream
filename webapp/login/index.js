// Already authenticated? Auth now lives in localStorage rather than a
// server-read cookie, so the server can't redirect logged-in visitors away
// from /login anymore. Do it here: if we already hold a token, head into
// the app. The app's own boot gate (webapp/alpha/m.js) bounces straight
// back here if that token turns out to be stale, so a bad token can't trap
// the user in a loop.
if (typeof Storage !== "undefined" && localStorage.getItem("token")) {
  window.location.assign(window.location.href.replace('/login', ''));
}

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

    window.location.assign(window.location.href.replace('/login', ''));

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