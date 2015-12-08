
/**
 * Node.js implementation of the NAT Port Mapping Protocol (a.k.a NAT-PMP).
 *
 * References:
 *   http://miniupnp.free.fr/nat-pmp.html
 *   http://wikipedia.org/wiki/NAT_Port_Mapping_Protocol
 *   http://tools.ietf.org/html/draft-cheshire-nat-pmp-03
 */

/**
 * Module dependencies.
 */

var dgram = require('dgram');
var assert = require('assert');
var debug = require('debug')('nat-pmp');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

/**
 * The ports defined in draft-cheshire-nat-pmp-03 to send NAT-PMP requests to.
 */

exports.CLIENT_PORT = 5350;
exports.SERVER_PORT = 5351;

/**
 * The opcodes for client requests.
 */

exports.OP_EXTERNAL_IP = 0;
exports.OP_MAP_UDP = 1;
exports.OP_MAP_TCP = 2;
exports.SERVER_DELTA = 128;

/**
 * Map of result codes the gateway sends back when mapping a port.
 */

exports.RESULT_CODES = {
  0: 'Success',
  1: 'Unsupported Version',
  2: 'Not Authorized/Refused (gateway may have NAT-PMP disabled)',
  3: 'Network Failure (gateway may have not obtained a DHCP lease)',
  4: 'Out of Resources (no ports left)',
  5: 'Unsupported opcode'
};

/**
 * Creates a Client instance. Familiar API to `net.connect()`.
 */

exports.connect = function (gateway) {
  var client = new Client(gateway);
  process.nextTick(function () {
    client.connect();
  });
  return client;
};

/**
 * The NAT-PMP "Client" class.
 */

function Client (gateway) {
  if (!(this instanceof Client)) {
    return new Client(gateway);
  }
  debug('creating new Client instance for gateway', gateway);
  EventEmitter.call(this);

  this._queue = [];
  this.listening = false;
  this.gateway = gateway;

  this.socket = dgram.createSocket('udp4');
  on('listening', this);
  on('message', this);
  on('close', this);
  on('error', this);
}
inherits(Client, EventEmitter);
exports.Client = Client;

/**
 * Binds to the nat-pmp Client port.
 */

Client.prototype.connect = function () {
  debug('Client#connect()');
  this._connecting = true;
  this.socket.bind(exports.CLIENT_PORT);
};

/**
 * Queues a UDP request to be send to the gateway device.
 */

Client.prototype.request = function (op, obj, cb) {
  if (typeof obj === 'function') {
    cb = obj;
    obj = null;
  }
  debug('Client#request()', [op, obj, cb]);
  var buf;
  var size;
  var pos = 0;

  switch (op) {
    case exports.OP_MAP_UDP:
    case exports.OP_MAP_TCP:
      if (!obj) {
        throw new Error('mapping a port requires an "options" object');
      }
      var internal = +(obj.private || obj.internal || 0);
      if (internal !== (internal | 0) || internal < 0) {
        throw new Error('the "private" port must be a whole integer >= 0');
      }
      var external = +(obj.public || obj.external || 0);
      if (external !== (external | 0) || external < 0) {
        throw new Error('the "public" port must be a whole integer >= 0');
      }
      var ttl = +(obj.ttl);
      if (ttl !== (ttl | 0)) {
        debug('using default "ttl" value of 3600');
        ttl = 3600;
      }
      size = 12;
      buf = new Buffer(size);
      buf.writeUInt8(0, pos); pos++;  // Vers = 0
      buf.writeUInt8(op, pos); pos++; // OP = x
      buf.writeUInt16BE(0, pos); pos+=2; // Reserved (MUST be zero)
      buf.writeUInt16BE(internal, pos); pos+=2; // Internal Port
      buf.writeUInt16BE(external, pos); pos+=2; // Requested External Port
      buf.writeUInt32BE(ttl, pos); pos+=4; // Requested Port Mapping Lifetime in Seconds
      break;
    case exports.OP_EXTERNAL_IP:
    default:
      if (op !== exports.OP_EXTERNAL_IP) {
        debug('WARN: invalid opcode given', op);
      }
      size = 2;
      buf = new Buffer(size);
      buf.writeUInt8(0, pos); pos++; // Vers = 0
      buf.writeUInt8(op, pos); pos++; // OP = x
  }
  assert.equal(pos, size, 'buffer not fully written!');

  // queue out the request
  this._queue.push({ op: op, buf: buf, cb: cb });
  this._next();
};

/**
 * Sends a request to the server for the current external IP address.
 */

Client.prototype.externalIp = function (cb) {
  this.request(exports.OP_EXTERNAL_IP, cb);
};

/**
 * Sets up a new port mapping.
 */

Client.prototype.portMapping = function (opts, cb) {
  var opcode;
  switch (String(opts.type || 'tcp').toLowerCase()) {
    case 'tcp':
      opcode = exports.OP_MAP_TCP;
      break;
    case 'udp':
      opcode = exports.OP_MAP_UDP;
      break;
    default:
      throw new Error('"type" must be either "tcp" or "udp"');
  }
  this.request(opcode, opts, cb);
};

/**
 * To unmap a port you simply set the TTL to 0.
 */

Client.prototype.portUnmapping = function (opts, cb) {
  opts.ttl = 0;
  return this.portMapping(opts, cb);
};

/**
 * Processes the next request if the socket is listening.
 */

Client.prototype._next = function () {
  debug('Client#_next()');
  var req = this._queue[0];
  if (!req) {
    debug('_next: nothing to process');
    return;
  }
  if (!this.listening) {
    debug('_next: not "listening" yet, cannot send out request yet');
    if (!this._connecting) {
      this.connect();
    }
    return;
  }
  if (this._reqActive) {
    debug('_next: already an active request so waiting...');
    return;
  }
  this._reqActive = true;
  this._req = req;

  var self = this;
  var buf = req.buf;
  var size = buf.length;
  var port = exports.SERVER_PORT;
  var gateway = this.gateway;

  debug('_next: sending request', buf, gateway);
  this.socket.send(buf, 0, size, port, gateway, function (err, bytes) {
    if (err) {
      self.onerror(err);
    } else if (bytes !== size) {
      self.onerror(new Error('Entire request buffer not sent. This should not happen!'));
    }
  });
};

/**
 * Closes the underlying socket.
 */

Client.prototype.close = function () {
  debug('Client#close()');
  if (this.socket) {
    this.socket.close();
  }
};

/**
 * Called for the underlying socket's "listening" event.
 */

Client.prototype.onlistening = function () {
  debug('Client#onlistening()');
  this.listening = true;
  this._connecting = false;
  this.emit('listening');
  this._next();
};

/**
 * Called for the underlying socket's "message" event.
 */

Client.prototype.onmessage = function (msg, rinfo) {
  // Ignore message if we're not expecting it
  if (this._queue.length === 0) return;

  debug('Client#onmessage()', [msg, rinfo]);

  function cb (err) {
    debug('invoking "req" callback');
    self._reqActive = false;
    if (err) {
      if (req.cb) {
        req.cb.call(self, err);
      } else {
        self.emit('error', err);
      }
    } else if (req.cb) {
      req.cb.apply(self, arguments);
    }
    self._next();
  }

  var self = this;
  var req = this._queue[0];
  var parsed = { msg: msg };
  var pos = 0;
  parsed.vers = msg.readUInt8(pos); pos++;
  parsed.op = msg.readUInt8(pos); pos++;

  if (parsed.op - exports.SERVER_DELTA !== req.op) {
    debug('onmessage: WARN: got unexpected message opcode; ignoring', parsed.op);
    return;
  }

  // if we got here, then we're gonna invoke the request's callback,
  // so shift this request off of the queue.
  debug('removing "req" off of the queue');
  this._queue.shift();

  if (parsed.vers !== 0) {
    cb(new Error('"vers" must be 0. Got: ' + parsed.vers));
    return;
  }

  // common fields
  parsed.resultCode = msg.readUInt16BE(pos); pos += 2;
  parsed.resultMessage = exports.RESULT_CODES[parsed.resultCode];
  parsed.epoch = msg.readUInt32BE(pos); pos += 4;

  if (parsed.resultCode === 0) {
    // success response
    switch (req.op) {
      case exports.OP_EXTERNAL_IP:
        parsed.ip = [];
        parsed.ip.push(msg.readUInt8(pos)); pos++;
        parsed.ip.push(msg.readUInt8(pos)); pos++;
        parsed.ip.push(msg.readUInt8(pos)); pos++;
        parsed.ip.push(msg.readUInt8(pos)); pos++;
        break;
      case exports.OP_MAP_UDP:
      case exports.OP_MAP_TCP:
        parsed.private = parsed.internal = msg.readUInt16BE(pos); pos += 2;
        parsed.public = parsed.external = msg.readUInt16BE(pos); pos += 2;
        parsed.ttl = msg.readUInt32BE(pos); pos += 4;
        parsed.type = req.op === 1 ? 'udp' : 'tcp';
        break;
      default:
        return cb(new Error('unknown OP code: ' + req.op));
    }
    assert.equal(msg.length, pos);
    cb(null, parsed);
  } else {
    // error response
    var err = new Error(parsed.resultMessage);
    err.code = parsed.resultCode;
    cb(err);
  }
};

/**
 * Called for the underlying socket's "close" event.
 */

Client.prototype.onclose = function () {
  debug('Client#onclose()');
  this.listening = false;
  this.socket = null;
};

/**
 * Called for the underlying socket's "error" event.
 */

Client.prototype.onerror = function (err) {
  debug('Client#onerror()', [err]);
  if (this._req && this._req.cb) {
    this._req.cb(err);
  } else {
    this.emit('error', err);
  }
};


function on (name, target) {
  target.socket.on(name, function () {
    debug('on: socket event %j', name);
    return target['on' + name].apply(target, arguments);
  });
}
