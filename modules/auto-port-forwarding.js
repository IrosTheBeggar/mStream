const natupnp = require('nat-upnp');
const winston = require('winston');

var tunnelInterval;

function set_gateway(gateIP) {
  gateway = gateIP;
}


function tunnel(port, protocol, callback) {
  tunnel_uPNP(port, callback);
}


function tunnel_uPNP(port, callback) {
  winston.info('Preparing to tunnel via upnp protocol');
  var client = natupnp.createClient();

  client.portMapping({
    public: port,
    private: port,
    ttl: 0
  }, function (err) {
    // Will be called once finished
    if (err) {
      winston.error(`uPNP failed: ${err}`);

      // Clear Interval
      if (tunnelInterval && callback) {
        clearInterval(tunnelInterval);
      }

      if (callback) {
        callback(false);
      }
      return;
    }
    if (callback) {
      callback(true);
    }
  });
}

exports.setup = function (program, callback) {
  if (program.tunnel.gateway) {
    set_gateway(args.gateway);
  }

  if (program.tunnel.refreshInterval) {
    tunnelInterval = setInterval(function () {
      tunnel(program.port, program.tunnel.protocol);
    }, program.tunnel.refreshInterval);
  }

  tunnel(program.port, program.tunnel.protocol, callback);
}
