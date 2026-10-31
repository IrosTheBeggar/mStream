/**
 * A stand-in for the @number0/iroh native module: just enough Endpoint for
 * state/iroh.js and state/federation.js to start(), stop() and answer their
 * admin status routes — no sockets, no relay. Nobody ever dials in:
 * acceptNext() parks until close(). Map the specifier here with
 * module.registerHooks before the first start() (iroh-bridge-check.test.mjs).
 */

let nextId = 0;

class FakeAddr {
  constructor(id) { this._id = id; }
  id() { return this._id; }
  relayUrl() { return null; }
  directAddresses() { return []; }
}

export class Endpoint {
  static bind() { return Promise.resolve(new Endpoint()); }

  constructor() {
    const name = `fake-endpoint-${++nextId}`;
    this._id = { toString: () => name };
    this._closed = false;
    this._parked = [];
  }

  id() { return this._id; }
  addr() { return new FakeAddr(this._id); }
  async online() {}

  acceptNext() {
    if (this._closed) { return Promise.resolve(null); }
    return new Promise((resolve) => { this._parked.push(resolve); });
  }

  close() {
    this._closed = true;
    for (const resolve of this._parked.splice(0)) { resolve(null); }
    return Promise.resolve();
  }
}

export class EndpointTicket {
  static fromAddr(addr) { return new EndpointTicket(addr); }
  constructor(addr) { this._addr = addr; }
  toString() { return `fake-ticket-${this._addr.id()}`; }
}

export class EndpointAddr {
  constructor(id) { this._addr = new FakeAddr(id); }
  id() { return this._addr.id(); }
  relayUrl() { return null; }
  directAddresses() { return []; }
}
