'use strict';

var asyncLoop = require('../index');
var dummyArray = require('./dummyArray');


//Make an array of asynchronous functions
var arr = dummyArray(10);


/*
All methods accept .next are chainable
*/
var loop = asyncLoop.create(arr);

loop.on('next', function (elm, i, array) {
    elm(function () {
        console.log(i);
        loop.next();
    });
}).on('done', function () {
    console.log('Done!');
}).start();