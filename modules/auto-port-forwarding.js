const natupnp = require('nat-upnp');
const publicIp = require('public-ip');
// const natpmp = require('nat-pmp');  TODO: Add nat-pmp back in once I find a good way to auto-detect the gateway IP on windows

var gateway;
var tunnelInterval;

function set_gateway(gateIP) {
  gateway = gateIP;
}


function tunnel(port, protocol, callback) {
  tunnel_uPNP(port, callback);

  // if(protocol === 'natpmp'){, callback
  //   tunnel_NAT_PMP(port);
  //   console.log('natpmp not currently supported')
  // }else{
  //   tunnel_uPNP(port);, callback
  // }
}


function tunnel_uPNP(port, callback) {
  console.log('Preparing to tunnel via upnp protocol');

  var client = natupnp.createClient();

  client.portMapping({
    public: port,
    private: port,
    ttl: 0
  }, function (err) {
    // Will be called once finished
    if (err) {
      console.log("uPNP failed.  Your port may already be in use");

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

// function tunnel_NAT_PMP(port){
//   console.log('Preparing to tunnel via nat-pmp protocol');
//
//   try{
//
//     // Use the user supplied Gateway IP or try to find it manually
//     if(!gateway){
//       gateway = require('netroute').getGateway();
//     }
//
//     var client = new natpmp.Client(gateway);
//     client.portMapping({ public: port, private: port }, function (err, info) {
//       if (err) {
//         throw err;
//       }
//       client.close();
//     });
//   }
//   catch (e) {
//     console.log('WARNING: mStream nat-pmp tunnel functionality has failed.  Your network may not allow functionality');
//     console.log(e);
//   }
// }



// function logUrl (port){
//   publicIp.v4().then(ip => {
//     console.log('Access mStream on the internet: http://' + ip + ':' + port);
//   });
// }

// TODO: Clean this up
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
