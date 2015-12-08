
var natpmp = require('../');

var client = new natpmp.Client('10.0.1.1');

client.portUnmapping({ public: 3000, private: 3000 }, function (err, info) {
  if (err) throw err;
  console.log('Port Unmapping:', info);
  client.close();
});
