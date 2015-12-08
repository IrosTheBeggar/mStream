
var natpmp = require('../');
var assert = require('assert');
var netroute = require('netroute');
var gateway = netroute.getGateway();

var client = new natpmp.Client(gateway);

client.request(17, function (err) {
  assert(err);
  console.log('Got error:', err);
  assert.equal(5, err.code);
  client.close();
});
