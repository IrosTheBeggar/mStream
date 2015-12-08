'use strict';

var asyncLoop = require('../index');
var dummyArray = require('./dummyArray');


/*
Make an array of asynchronous functions
*/
var arr = dummyArray(10);

var loop = asyncLoop.create(arr);

loop.on('next', function (elm, i, array) {
    elm(function () {
        if (i === 5) {
            // Stop the loop early, you can pass any number of arguments to .done
            loop.done(i, 'i am Batman');
        }
        loop.next();
    });
}).on('done', function (i, msg) {
    console.log('Loop stopped at %s and %s', i, msg);
}).start();