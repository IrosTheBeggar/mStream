const API = (() => {
  const module = {};

  // initialize with a default server
  module.servers = [{
    name: "default",
    url: '..', // This is some hacky bullshit to get relative URLs working
    token: localStorage.getItem('token')
  }];

  module.selectedServer = 0;

  module.name = () => {
    return module.servers[module.selectedServer].name;
  }

  module.token = () => {
    return module.servers[module.selectedServer].token;
  }

  module.url = () => {
    return module.servers[module.selectedServer].url;
  }

  module.logout = () => {
    localStorage.removeItem('token');
    // js-cookie is a `defer` script on the admin page and absent entirely on
    // the login page, so it can be undefined here. Clearing the cookie is
    // best-effort — never let it swallow the redirect below.
    try { Cookies.remove('x-access-token'); } catch (err) { /* no js-cookie on this page */ }
    document.location.assign(window.location.href.replace('/admin', '') + (window.location.href.slice(-1) === '/' ? '' : '/') + 'login');
  }

  module.goToPlayer = () => {
    window.location.assign(window.location.href.replace('/admin', ''));
  }

  module.axios = axios.create();

  // Only attach the header when a token actually exists.
  //
  // localStorage is origin-scoped; the session cookie the server sets at
  // login is host-only and ignores port AND scheme. So a user who logged in
  // at http://host:3000 and came back through https://host — or whose
  // script-writable storage was evicted (Safari ITP does this after 7 days) —
  // still has a perfectly valid cookie but NO localStorage entry.
  //
  // Sending the resulting null anyway is strictly worse than sending nothing:
  // axios 0.19 does not drop it, it serialises it onto the wire as the string
  // "[object Object]", and src/api/auth.js reads the header BEFORE the cookie.
  // The garbage then shadows the valid cookie and every admin call 401s with
  // "jwt malformed" — the whole panel dies while the player, which does guard
  // this (webapp/alpha/m.js), keeps working.
  //
  // Reading inside the interceptor rather than freezing the value at module
  // init also means a token set after load is picked up.
  module.axios.interceptors.request.use(config => {
    const token = module.token();
    if (token) { config.headers['x-access-token'] = token; }
    return config;
  });

  // A 401 means the credentials we hold are dead or absent — the only useful
  // move is to re-authenticate. Without this the panel just sat there: the
  // admin panel's boot-time loaders are fire-and-forget, so a 401 became an
  // unhandled rejection and the spinner spun forever with nothing on screen to
  // explain it. Guarded so the ~25 parallel boot requests redirect exactly once.
  //
  // Deliberately 401-only. A locked admin API answers 405 and an off-network
  // admin request answers 403 (src/api/admin.js); neither is fixed by logging
  // in again, so neither should bounce the operator to the login page.
  let redirecting = false;
  module.axios.interceptors.response.use(undefined, err => {
    if (err.response && err.response.status === 401 && !redirecting) {
      redirecting = true;
      module.logout();
    }
    return Promise.reject(err);
  });

  return module;
})();