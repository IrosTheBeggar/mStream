import { randomBytes } from 'node:crypto';

export function newId(len = 21) {
  return randomBytes(len).toString('base64url').slice(0, len);
}
