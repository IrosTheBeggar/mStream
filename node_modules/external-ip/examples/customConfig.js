'use strict';

var extIP = require('../index');

var getIP = extIP({
    replace: true, // true: replace the default services list, false: extend it, default: false
    services: ['http://ifconfig.co/x-real-ip', 'http://ifconfig.io/ip'],
    timeout: 600, // set timeout per request, default: 500ms
    'getIP': 'parallel'
});

getIP(function (err, ip) {
    if (err) {
        throw err;
    }
    console.log(ip);
});
