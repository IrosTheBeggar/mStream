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

  module.checkAuthAndKickToLogin = async () => {
    // Send request to server
    try {
      await axios({
        method: 'GET',
        url: `${module.url()}/api/`,
        headers: { 'x-access-token': module.token() }
      });
    } catch (err) {
      window.location.href = `../login?redirect=${encodeURIComponent(window.location.pathname)}`;
    }
  }

  module.logout = () => {
    localStorage.removeItem('token');
    Cookies.remove('x-access-token');
    window.location.href = '../login';
  }

  module.goToPlayer = () => {
    window.location.assign('../');
  }

  module.axios = axios.create({
    headers: { 'x-access-token': module.token() }
  });

  return module;
})();