'use strict';

var getIP = require('../index')();

getIP(function (err, ip) {
    if (err) {
        throw err;
    }
    console.log(ip);
});
