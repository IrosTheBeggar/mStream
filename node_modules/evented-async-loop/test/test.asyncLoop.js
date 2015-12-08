'use strict';
/* globals describe, it, beforeEach*/
var expect = require('chai').expect;
var asyncLoop = require('../index');

var arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
var loop;


describe('asyncLoop.js test', function () {

    beforeEach(function () {
        loop = asyncLoop.create(arr);
    });

    it('should play nice!', function (done) {
        loop.on('next', function (elm, i, arr, arg1, arg2) {
            expect(elm).to.equal(i);
            expect(arg1).to.equal(arg2);
            loop.next(++arg1, ++arg2);
        });

        loop.on('done', function (arg1, arg2) {
            expect(arg1).to.equal(arg2).to.equal(arr.length);
            done();
        });

        loop.start(0, 0);
    });

    it('should stop early nice', function (done) {

        loop.on('next', function (elm, i, arr, arg1, arg2) {
            expect(elm).to.equal(i);
            expect(arg1).to.equal(arg2);
            if (i === 5) {
                loop.done(i, 'yeyyeeee');
            }
            loop.next(++arg1, ++arg2);
        });

        loop.on('done', function (arg1, arg2) {
            expect(arg1).to.equal(5);
            expect(arg2).to.equal('yeyyeeee');
            done();
        });

        loop.start(0, 0);
    });

    it('should emit error and break', function (done) {
        loop.on('next', function (elm) {
            if (elm === 9) {
                loop.error(elm).break();
            }

            loop.next();
        });
        loop.on('done', function () {
            throw new Error('this sould not have been called');
        });
        loop.on('error', function (err) {
            expect(err).to.equal(9);
            done();
        });
        loop.start();
    });

    it('sould be chainable', function (done) {
        loop.on('next', function () {
            loop.next();
        }).on('done', function () {
            done();
        }).start();
    });

    it('sould be tolerant to abuse', function (done) {
        loop.start().on('next', function () {
            loop.next();
        }).on('done', function () {
            done();
        });
    });
});