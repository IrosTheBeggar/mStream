'use strict';
var requests = require('./requests');
var asyncLoop = require('evented-async-loop');
var utils = require('./utils');

module.exports = function (extConf) {
    extConf = extConf || {};

    var isValid = utils.validateConfig(extConf);

    if (isValid.errors.length) {
        console.error(isValid.errors);
        process.exit(1);
    }

    // Check: https://github.com/mjhasbach/MOIRA
    var defConf = {
        getIP: 'sequential', // parallel
        replace: false,
        services: [
            'http://ifconfig.co/x-real-ip',
            'http://icanhazip.com/',
            'http://ifconfig.io/ip',
            'http://ip.appspot.com/',
            'http://curlmyip.com/',
            'http://ident.me/',
            'http://whatismyip.akamai.com/',
            'http://tnx.nl/ip',
            'http://myip.dnsomatic.com/',
            'http://ipecho.net/plain',
            'http://diagnostic.opendns.com/myip'
        ],
        timeout: 1000
    };

    var config = utils.mergeConfig(extConf, defConf);

    var services = requests.setup(config).services;

    var loop = asyncLoop.create(services);


    var getIP = {
        sequential: function (cb) {

            loop.on('next', function (service, i, arr, errors) {
                service.getIP(function (err, ip) {
                    if (err) {
                        errors.push(service.url + ' : ' + err);
                        loop.next(errors);
                    } else {
                        loop.done(null, ip);
                    }
                });
            })
            .on('done', function (errors, ip) {
                cb.apply(null, ip ? [null, ip] : [errors, null]);
            })
            .start([]);
        },

        parallel: function (cb) {
            var done = false;
            var errors = [];
            var requests;

            var abort = function (requests) {
                process.nextTick(function () {
                    requests.forEach(function (request) {
                        request.abort();
                    });
                });
            };


            var onResponse = function (err, ip) {

                if (done) {
                    return;
                }
                if (err) {
                    errors.push(err);
                }
                if(ip) {
                    done = true;
                    abort(requests); //async
                    return cb(null, ip);
                }
                if (errors.length === services.length) {
                    done = true;
                    abort(requests); //async
                    return cb(errors, null);
                }
            };

            requests = services.map(function (service) {
                return service.getIP(onResponse);
            });

        }
    };

    return getIP[config.getIP];
};
