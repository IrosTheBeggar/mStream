'use strict';

var asyncLoop = require('../index');
var dummyArray = require('./dummyArray');


/*
Make an array of asynchronous functions
*/
var arr = dummyArray(10);


/*
Error handling
*/
var loop = asyncLoop.create(arr);

loop.on('next', function (elm, i, array) {
    elm(function () {
        if (i === 3) {
            // Emitting an error event will not break the loop
            loop.error('Oh noez!');
        }

        if (i === 8) {
            // But if you need to break the loop and emit an error
            loop.break().error('This will stop the loop');
            // or, loop.error('This will stop the loop').break();
            // if you want to emit the error first
        }

        loop.next();
    });
}).on('done', function () {
    // This wont run
    console.log('Done!');
}).on('error', function (err) {
    console.log(err);
}).start();