import { Jimp } from 'jimp';
import Joi from 'joi';
import fs from 'fs/promises';
import path from 'path';
import mime from 'mime-types';

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (error) {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  albumArtDirectory: Joi.string().required(),
});

const { error, value } = schema.validate(loadJson);
if (error) {
  console.error(`Invalid JSON Input`);
  console.log(error);
  process.exit(1);
}

run();

async function run() {
  let files;
  try {
    files = await fs.readdir(loadJson.albumArtDirectory);
  } catch(error) {
    console.log(error);
    process.exit(1);
  }

  for (const file of files) {
    let filepath;
    try {
      filepath = path.join(loadJson.albumArtDirectory, file);
      const stat = await fs.stat(filepath);
      if (stat.isDirectory()) { continue; }
      const mimeType = mime.lookup(path.extname(file));
      if (!mimeType.startsWith('image')) { continue; }
      if (file.startsWith('zs-') || file.startsWith('zl-') || file.startsWith('zm-')) { continue; }

      const img = await Jimp.read(filepath);
      await img.scaleToFit({ w: 256, h: 256 }).write(path.join(loadJson.albumArtDirectory, 'zl-' + file));
      await img.scaleToFit({ w: 92, h: 92 }).write(path.join(loadJson.albumArtDirectory, 'zs-' + file));
    } catch (error) {
      console.log('error on file: ' + filepath);
      console.error(error);
    }
  }
}
