const natupnp = require('nat-upnp');
const getIP = require('external-ip')();
const natpmp = require('nat-pmp');

var gateway;

function set_gateway (gateIP){
  gateway = gateIP;
}


function tunnel_uPNP (port){
  try{

    var client = natupnp.createClient();

    client.portMapping({
      public: port,
      private: port,
      ttl: 10
    }, function(err) {
      // Will be called once finished
      if (err) {
        // every service in the list has failed
        throw err;
      }
    });

  }
  catch (e) {
    console.log('WARNING: mStream uPNP tunnel functionality has failed.  Your network may not allow this functionality');
    console.log(e);

  }
}

function tunnel_NAT_PMP(port){
  try{

    // Use the user supplied Gateway IP or try to find it manually
    if(!gateway){
      gateway = require('netroute').getGateway();
    }

    var client = new natpmp.Client(gateway);
    client.portMapping({ public: port, private: port }, function (err, info) {
      if (err) {
        throw err;
      }
      client.close();
    });
  }
  catch (e) {
    console.log('WARNING: mStream nat-pmp tunnel functionality has failed.  Your network may not allow functionality');
    console.log(e);
  }
}



function logUrl (port){
  getIP(function (err, ip) {
    if (err) {
      // every service in the list has failed
      throw err;
    }
    console.log('Access mStream on the internet: http://' + ip + ':' + port);
  });
}


exports.setup = function(args, port){
  if(args.gateway){
    tunnel.set_gateway(args.gateway);
  }

  console.log('Preparing to tunnel via nat-pmp protocol');

  // TODO: Clean this up, this it so lazy...
  if(args.protocol && args.protocol === 'upnp'){
    // Run it on an interval ?
    if(args.refreshInterval){
      setInterval( function() {
        tunnel_uPNP(port);
      }, args.refreshInterval);
    }else{
      tunnel_uPNP(port);
    }
  }else{
    // Run it on an interval ?
    if(args.refreshInterval){
      setInterval( function() {
        tunnel_NAT_PMP(port);
      }, argsrefreshInterval);
    }else{
      tunnel_NAT_PMP(port);
    }
  }



  logUrl(port);
}
