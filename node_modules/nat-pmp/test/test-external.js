
var natpmp = require('../');
var netroute = require('netroute');
var gateway = netroute.getGateway();

var client = new natpmp.Client(gateway);

client.externalIp(function (err, info) {
  if (err) throw err;
  console.log('External IP Address:', info.ip.join('.'));
  client.close();
});
