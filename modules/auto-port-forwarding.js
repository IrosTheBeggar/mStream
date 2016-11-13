const natupnp = require('nat-upnp');
const getIP = require('external-ip')();
const natpmp = require('nat-pmp');


exports.tunnel_uPNP = function(port){
  try{
    console.log('Preparing to tunnel via upnp protocol');

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

exports.tunnel_NAT_PMP = function tunnel_NAT_PMP(port){
  try{
    console.log('Preparing to tunnel via nat-pmp protocol');



    // Use the user supplied Gateway IP or try to find it manually
    if(program.gateway){
      var gateway = program.gateway;
    }else{
      var netroute = require('netroute');
      var gateway = netroute.getGateway();
    }

    console.log('Attempting to tunnel via gateway: ' + gateway);

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



exports.logUrl = function(port){
  getIP(function (err, ip) {
    if (err) {
      // every service in the list has failed
      throw err;
    }
    console.log('Access mStream on the internet: http://' + ip + ':' + port);
  });
}
