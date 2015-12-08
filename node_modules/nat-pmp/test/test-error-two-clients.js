
var natpmp = require('../');
var assert = require('assert');
var netroute = require('netroute');
var gateway = netroute.getGateway();

var first = natpmp.connect(gateway);

first.once('listening', function () {
  var second = natpmp.connect(gateway);

  second.externalIp(function (err) {
    assert(err);
    console.log('Got error:', err);
    assert(/EALREADY|EADDRINUSE/.test(err.code));

    first.close();
  });
});
