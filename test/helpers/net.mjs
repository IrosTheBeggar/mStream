// Socket helpers for tests of a server that does not listen on 127.0.0.1
// (mStream#1101: bound to one LAN address, it refuses a loopback connect).
import net from 'node:net';
import os from 'node:os';

// 'connected', or the error code a TCP connect to host:port gets.
export function connectOutcome(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (err) => resolve(err.code));
  });
}

// An address other than 127.0.0.1 this machine can listen on, or null: its
// non-loopback IPv4s first (one may be tentative, or a VPN's that refuses a
// bind), then a second loopback address (Linux and Windows route all of
// 127/8 locally; macOS does not).
export async function otherInterfaceAddress() {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  for (const address of [...lan, '127.0.0.2']) {
    if (await canListen(address)) { return address; }
  }
  return null;
}

function canListen(address) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, address, () => s.close(() => resolve(true)));
  });
}
