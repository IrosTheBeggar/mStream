// The track credit roles (track_artists.role) — one place for the vocabulary
// the scanners write and the API filters on (V72).
//
//   performer roles  'main' (tracks.artist_id, position 0) and 'featured'
//                    (the other ARTIST-tag names, tag order) — what "songs by
//                    this artist" means everywhere unless a request widens it
//   credit roles     'composer' 'conductor' 'remixer' 'lyricist' — from the
//                    COMPOSER / CONDUCTOR / REMIXER / LYRICIST tags (TCOM /
//                    TPE3 / TPE4 / TEXT); they never leak into a default
//                    read path (artists index, artists-albums, album-songs
//                    `artist`, the Auto-DJ artist filter)
//
// The role values are constants, so the SQL helpers below interpolate them
// as literals — never pass request input through them.

export const PERFORMER_ROLES = ['main', 'featured'];
export const CREDIT_ROLES = ['composer', 'conductor', 'remixer', 'lyricist'];
export const TRACK_ROLES = [...PERFORMER_ROLES, ...CREDIT_ROLES];

export const sqlRoleList = (roles) => roles.map((r) => `'${r}'`).join(', ');
// `role IN (${PERFORMER_ROLES_SQL})`
export const PERFORMER_ROLES_SQL = sqlRoleList(PERFORMER_ROLES);
