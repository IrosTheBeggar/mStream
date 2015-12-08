'use strict';
var asyncFactory = function (i) {
    return function (cb) {
        setTimeout(cb.bind(null, i),0);
    };
};

module.exports = function (length) {
    var arr = [];
    var i = 0;
    for (i; i < length; i += 1) {
        arr.push(asyncFactory(i));
    }
    return arr;
};