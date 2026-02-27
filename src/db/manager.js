import winston from 'winston';
import * as config from '../state/config.js';

let backend;
let clearShared;

export async function initDB() {
  if (config.program.db.engine === 'sqlite') {
    backend = await import('./sqlite-backend.js');
  } else {
    backend = await import('./loki-backend.js');
  }

  await backend.init(config.program.storage.dbDirectory, config.program.db);

  // Shared playlist cleanup interval
  if (clearShared) {
    clearInterval(clearShared);
    clearShared = undefined;
  }

  if (config.program.db.clearSharedInterval) {
    clearShared = setInterval(() => {
      try {
        backend.removeExpiredSharedPlaylists();
        backend.saveShareDB();
        winston.info('Successfully cleared shared playlists');
      } catch (err) {
        winston.error('Failed to clear expired saved playlists', { stack: err });
      }
    }, config.program.db.clearSharedInterval * 60 * 60 * 1000);
  }
}

// Save operations
export function saveFilesDB() { backend.saveFilesDB(); }
export function saveUserDB() { backend.saveUserDB(); }
export function saveShareDB() { backend.saveShareDB(); }

// File Operations
export function findFileByPath(filepath, vpath) { return backend.findFileByPath(filepath, vpath); }
export function updateFileScanId(file, scanId) { return backend.updateFileScanId(file, scanId); }
export function insertFile(fileData) { return backend.insertFile(fileData); }
export function removeFileByPath(filepath, vpath) { return backend.removeFileByPath(filepath, vpath); }
export function removeStaleFiles(vpath, scanId) { return backend.removeStaleFiles(vpath, scanId); }
export function removeFilesByVpath(vpath) { return backend.removeFilesByVpath(vpath); }
export function countFilesByVpath(vpath) { return backend.countFilesByVpath(vpath); }

// Metadata Queries
export function getFileWithMetadata(filepath, vpath, username) { return backend.getFileWithMetadata(filepath, vpath, username); }
export function getArtists(vpaths, ignoreVPaths) { return backend.getArtists(vpaths, ignoreVPaths); }
export function getArtistAlbums(artist, vpaths, ignoreVPaths) { return backend.getArtistAlbums(artist, vpaths, ignoreVPaths); }
export function getAlbums(vpaths, ignoreVPaths) { return backend.getAlbums(vpaths, ignoreVPaths); }
export function getAlbumSongs(album, vpaths, username, opts) { return backend.getAlbumSongs(album, vpaths, username, opts); }
export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths) { return backend.searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths); }
export function getRatedSongs(vpaths, username, ignoreVPaths) { return backend.getRatedSongs(vpaths, username, ignoreVPaths); }
export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths) { return backend.getRecentlyAdded(vpaths, username, limit, ignoreVPaths); }
export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths) { return backend.getRecentlyPlayed(vpaths, username, limit, ignoreVPaths); }
export function getMostPlayed(vpaths, username, limit, ignoreVPaths) { return backend.getMostPlayed(vpaths, username, limit, ignoreVPaths); }
export function getAllFilesWithMetadata(vpaths, username, opts) { return backend.getAllFilesWithMetadata(vpaths, username, opts); }

// User Metadata
export function findUserMetadata(hash, username) { return backend.findUserMetadata(hash, username); }
export function insertUserMetadata(obj) { return backend.insertUserMetadata(obj); }
export function updateUserMetadata(obj) { return backend.updateUserMetadata(obj); }
export function removeUserMetadataByUser(username) { return backend.removeUserMetadataByUser(username); }

// Playlists
export function getUserPlaylists(username) { return backend.getUserPlaylists(username); }
export function findPlaylist(username, playlistName) { return backend.findPlaylist(username, playlistName); }
export function createPlaylistEntry(entry) { return backend.createPlaylistEntry(entry); }
export function deletePlaylist(username, playlistName) { return backend.deletePlaylist(username, playlistName); }
export function getPlaylistEntryById(id) { return backend.getPlaylistEntryById(id); }
export function removePlaylistEntryById(id) { return backend.removePlaylistEntryById(id); }
export function loadPlaylistEntries(username, playlistName) { return backend.loadPlaylistEntries(username, playlistName); }
export function removePlaylistsByUser(username) { return backend.removePlaylistsByUser(username); }

// Shared Playlists
export function findSharedPlaylist(playlistId) { return backend.findSharedPlaylist(playlistId); }
export function insertSharedPlaylist(item) { return backend.insertSharedPlaylist(item); }
export function getAllSharedPlaylists() { return backend.getAllSharedPlaylists(); }
export function removeSharedPlaylistById(playlistId) { return backend.removeSharedPlaylistById(playlistId); }
export function removeExpiredSharedPlaylists() { return backend.removeExpiredSharedPlaylists(); }
export function removeEternalSharedPlaylists() { return backend.removeEternalSharedPlaylists(); }
export function removeSharedPlaylistsByUser(username) { return backend.removeSharedPlaylistsByUser(username); }
