const API = (() => {
  const module = {};

  // initialize with a default server
  module.servers = [{
    name: "default",
    url: window.location.origin,
    token: localStorage.getItem('authToken')
  }];

  module.selectedServer = 0;

  module.addServer = (name, url, username, password) => {
    module.servers.push({
      name: name,
      url: url,
      token: null
    })
  }

  module.url = () => {
    return module.servers[module.selectedServer].url;
  }

  module.checkAuthAndKickToLogin = async () => {
    if (module.servers[0].token === null) {
      window.location.replace(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
    }

    // Send request to server
    try {
      await axios({
        method: 'GET',
        url: `${module.url()}/api/`,
        headers: { 'x-access-token': module.servers[0].token }
      });
    } catch (err) {
      window.location.replace(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
    }
  }

  module.logout = () => {
    localStorage.removeItem('authToken');
    window.location.replace(`/login`);
  }

  module.axios = axios.create({
    baseURL: module.url(),
    headers: { 'x-access-token': module.servers[0].token }
  });

  // TODO: We also need a way to save servers
  module.changeDefaultServer = (serverIndex) => {
    // TODO: Throw Error?
    if (!module.servers[serverIndex]) { return false; }

    module.selectedServer = serverIndex;

    // TODO: update module.axios to use the token for that server
  }

  return module;
})();