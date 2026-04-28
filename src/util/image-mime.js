const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
};

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.svg',
]);

export function extFromImageMime(mimeStr) {
  if (typeof mimeStr !== 'string') return null;
  return MIME_TO_EXT[mimeStr.toLowerCase()] ?? null;
}

export function isImageExtension(extWithDot) {
  if (typeof extWithDot !== 'string') return false;
  return IMAGE_EXTS.has(extWithDot.toLowerCase());
}
