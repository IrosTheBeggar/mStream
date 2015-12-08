var bindings = require('bindings');

exports.getInfo = bindings('netroute').getInfo;

exports.getGateway = function getGateway(interface) {
  var info = exports.getInfo(),
      def;

  // Search in IPv4 list
  def = info.IPv4.filter(function(route) {
    return route.destination === '0.0.0.0' &&
           (!interface || route.interface === interface);
  });

  if (def.length !== 0) return def[0].gateway;

  // And in IPv6 list
  def = info.IPv6.filter(function(route) {
    return route.destination === '::0' &&
           (!interface || route.interface === interface);
  });

  return def[0] ? def[0].gateway : null;
};
