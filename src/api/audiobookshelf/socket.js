// Socket.IO server for Audiobookshelf clients.
//
// Audiobookshelf mobile apps connect to /socket.io on the same host
// they hit for the REST API. They emit `init` with the JWT token after
// connecting, then expect server-sent `user_updated` and
// `media_progress_update` events whenever the user's state changes
// elsewhere (e.g. on a second device).
//
// We attach to the same HTTP server Express is running on — Socket.IO
// shares the port and only handles requests at the /socket.io path,
// so it doesn't interfere with /api/* or /rest/*.
//
// Auth model: connections are accepted unauthenticated; the client
// proves identity via the `init` event with a JWT in the payload.
// Unauthenticated sockets receive no broadcasts. This matches what
// Audiobookshelf itself does — the alternative (rejecting handshake
// without auth) breaks reconnection during token refresh.

import jwt from 'jsonwebtoken';
import * as config from '../../state/config.js';
import * as db from '../../db/manager.js';
import winston from 'winston';
import { setProgressEmitter } from './index.js';
import { bookProgressToMediaProgress } from './mappers.js';

let io = null;
const userSockets = new Map();   // user_id -> Set<Socket>

export async function attachAudiobookshelfSocket(httpServer) {
  const { Server: SocketIOServer } = await import('socket.io');
  io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: { origin: '*' },
    // Audiobookshelf apps use both transports; long-polling is the
    // fallback when WebSocket upgrade fails behind some proxies.
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    socket.data.userId = null;

    socket.on('init', (payload, ack) => {
      const token = payload?.token || payload?.user?.token;
      const userId = identifyUser(token);
      if (!userId) {
        if (typeof ack === 'function') { ack({ error: 'unauthenticated' }); }
        return;
      }
      socket.data.userId = userId;
      if (!userSockets.has(userId)) { userSockets.set(userId, new Set()); }
      userSockets.get(userId).add(socket);
      if (typeof ack === 'function') { ack({ ok: true }); }
    });

    socket.on('disconnect', () => {
      const uid = socket.data.userId;
      if (uid != null) {
        const set = userSockets.get(uid);
        if (set) {
          set.delete(socket);
          if (set.size === 0) { userSockets.delete(uid); }
        }
      }
    });

    // Audiobookshelf mobile apps emit a few other events the server
    // doesn't need to act on (typing-indicators, ping). Ignoring them
    // is fine — the apps don't expect responses.
    socket.on('user_session_listening_open', () => {});
    socket.on('user_session_listening_close', () => {});
  });

  // Wire the REST router's progress emitter to this socket's broadcaster.
  setProgressEmitter((userId, row) => {
    const set = userSockets.get(userId);
    if (!set || set.size === 0) { return; }
    const book = db.getDB().prepare(`SELECT * FROM books WHERE id = ?`).get(row.book_id);
    const payload = bookProgressToMediaProgress(row, book);
    for (const s of set) {
      s.emit('media_progress_update', payload);
    }
  });

  winston.info('Audiobookshelf Socket.IO attached on /socket.io');
  return io;
}

function identifyUser(token) {
  if (!token) { return null; }
  try {
    const decoded = jwt.verify(String(token), config.program.secret);
    if (!decoded?.username) { return null; }
    const user = db.getUserByUsername(decoded.username);
    return user?.id ?? null;
  } catch {
    return null;
  }
}
