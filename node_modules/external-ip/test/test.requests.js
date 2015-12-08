'use strict';

/*globals describe, it*/
var expect = require('chai').expect;
var requests = require('../lib/requests').setup({
    replace: false,
    services: ['http://ifconfig.co/x-real-ip', 'http://ifconfig.io/ip'],
    timeout: 500
});

// Request mocks
var request = {
    success: {
        get: function (opts, cb) {
            expect(opts).to.have.property('url', 'batman');
            expect(opts).to.have.property('timeout', 500);
            expect(opts).to.have.property('headers').with.property('User-Agent', 'curl/');
            cb(null, null, '94.65.128.173');
        }
    },
    fail: {
        get: function (opts, cb) {
            cb('booom', null, null);
        }
    },
    invalid: {
        get: function (opts, cb) {
            cb(null, null, 11111);
        }
    }
};

describe('requests.js test', function () {

    it('Should have correct request config and return without errors', function () {
        var req = requests.requestFactory(request.success, 'batman');
        req(function (err, ip) {
            expect(err).to.equal(null);
            expect(ip).to.equal('94.65.128.173');
        });
    });

    it('Should return with an error', function () {
        var req = requests.requestFactory(request.fail, 'batman');
        req(function (err, ip) {
            expect(err).to.equal('booom');
            expect(ip).to.equal(null);
        });
    });

    it('Should validate a correct ip', function () {
        var req = requests.requestFactory(request.success, 'batman');
        req = requests.addValidation(req);
        req(function (err, ip) {
            expect(err).to.equal(null);
            expect(ip).to.equal('94.65.128.173');
        });
    });

    it('Should return an error with an invalid ip', function () {
        var req = requests.requestFactory(request.invalid, 'batman');
        req = requests.addValidation(req);
        req(function (err, ip) {
            expect(err).to.be.instanceof(Error);
            expect(ip).to.equal(null);
        });
    });

});