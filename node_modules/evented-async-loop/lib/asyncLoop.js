'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');


var Loop = function (collection) {
    if (!collection || !Array.isArray(collection)) {
        throw new Error('please pass an array to the constructor ');
    }

    this.i = -1;
    this.collection = collection;
    this.isDone = false;

};

util.inherits(Loop, EventEmitter);

var L = Loop.prototype;

L.next = function ( /*args*/ ) {
    if (this.isDone) {
        return;
    }
    if (this.i < this.collection.length - 1) {
        this.i += 1;
        return this.emit.bind(this, 'next', this.collection[this.i], this.i, this.collection)
            .apply(this, arguments);

    }
    this.done.apply(this, arguments);

};

L.start = function ( /*args*/ ) {
    var args = arguments;
    process.nextTick(function () {
        this.next.apply(this, args);
    }.bind(this));
    return this;
};

L.done = function ( /*args*/ ) {
    this.isDone = true;
    this.emit.bind(this, 'done').apply(this, arguments);
    return this;
};

L.error = function ( /*args*/ ) {
    this.emit.bind(this, 'error').apply(this, arguments);
    return this;
};

L.break = function () {
    this.isDone = true;
    return this;
};


module.exports.create = function (c) {
    return new Loop(c);
};