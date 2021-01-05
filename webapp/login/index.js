// Check Token
async function checkToken() {
  if (!localStorage.getItem('token')) {
    return;
  }

  try {
    await axios({
      method: 'GET',
      url: `${API.url()}/api/`,
      headers: { 'x-access-token': localStorage.getItem('token') }
    });

    window.location.replace(`/`);
  } catch (err) {
    // localStorage.removeItem('token');
  }
}

checkToken();

document.getElementById("login").addEventListener("submit", async e =>{
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

    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    const goTo = urlParams.get('redirect') ? urlParams.get('redirect') : '/';
    window.location.replace(goTo);

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