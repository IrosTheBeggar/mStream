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
    Cookies.remove('x-access-token');
    document.location.assign(window.location.href.replace('/admin', '') + (window.location.href.slice(-1) === '/' ? '' : '/') + 'login');
  }

  module.goToPlayer = () => {
    window.location.assign(window.location.href.replace('/admin', ''));
  }

  module.axios = axios.create({
    headers: { 'x-access-token': module.token() }
  });

  return module;
})();