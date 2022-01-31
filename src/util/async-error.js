'use strict';
const Layer = require('express/lib/router/layer');

const noop = () => {};

Object.defineProperty(Layer.prototype, "handle", {
  enumerable: true,
  get: function() { return this.__handle; },
  set: function(fn) {
    if (isAsync(fn)) {
      fn = wrapAsync(fn);
    }

    this.__handle = fn;
  }
});

function isAsync(fn) {
  const type = Object.toString.call(fn.constructor);
  return type.indexOf('AsyncFunction') !== -1;
};

function wrapAsync(fn) {
  return (req, res, next = noop) => {
    fn(req, res, next)
      .catch((err) => {
        next(err);
      });
  }
};