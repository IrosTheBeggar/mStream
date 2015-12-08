
var natpmp = require('../');
var assert = require('assert');
var netroute = require('netroute');
var gateway = netroute.getGateway();

var client = new natpmp.Client(gateway);

client.portMapping({ public: 3000, private: 3000 }, function (err, info) {
  if (err) throw err;
  assert.equal(3000, info.private);
  assert.equal('tcp', info.type);
  console.log('Port Mapping:', info);
  client.close();
});
