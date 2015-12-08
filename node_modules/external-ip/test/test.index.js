'use strict';

/*globals it, describe*/

// Integration test
var extIP = require('../index');
var utils = require('../lib/utils');
var expect = require('chai').expect;

var timeout = 3000;


describe('index.js test', function () {
    it('Should return an IP with default configuration', function (done) {
        this.timeout(timeout);
        var getIP = extIP();
        getIP(function (err, ip) {
            expect(err).to.equal(null);
            expect(utils.isIP(ip)).to.equal(true);
            done();
        });
    });

    it('Should return an IP with custom configuration', function (done) {
        this.timeout(timeout);

        var getIP = extIP({
            replace: true, // true: replace the default services list, false: extend it, default: false
            services: ['http://ifconfig.co/x-real-ip', 'http://ifconfig.io/ip'],
            timeout: timeout, // set timeout per request, default: 500ms,
            getIP: 'parallel'
        });

        getIP(function (err, ip) {
            expect(err).to.equal(null);
            expect(utils.isIP(ip)).to.equal(true);
            done();
        });
    });
});