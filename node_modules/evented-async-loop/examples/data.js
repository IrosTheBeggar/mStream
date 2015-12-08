'use strict';

var asyncLoop = require('../index');
var dummyArray = require('./dummyArray');


//Make an array of asynchronous functions
var arr = dummyArray(10);


/*
Pass data to loop
*/
var loop = asyncLoop.create(arr);

// loop.start(...).on() is ok too!
loop.on('next', function (elm, i, array, arg1, arg2) { // extra arguments are appended
    elm(function () {
        // pass data to the next iteration
        loop.next(++arg1, arg2);
        // after the final iteration tha arguments are passed to 'done'
    });
}).on('done', function (arg1, arg2) {
    console.log('arg1: %s, arg2: %s', arg1, arg2);
}).start(0, 'blah'); // Pass any number of arguments