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
      title: 'Login Success!',
      position: 'topCenter',
      timeout: 3500
    });
  } catch (err) {
    iziToast.error({
      title: 'Login Failed',
      position: 'topCenter',
      timeout: 3500
    });
  }

  document.getElementById("form-submit").disabled = false;
});