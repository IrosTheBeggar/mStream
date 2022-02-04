const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');
const { createFFmpeg, fetchFile } = require('@ffmpeg/ffmpeg');

const waitFor = delay => new Promise(resolve => setTimeout(resolve, delay));

const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const output = path.resolve(__dirname, 'video.mp4');

const video = ytdl(url, {
  quality: 'highestaudio',
});
video.pipe(fs.createWriteStream(output));

video.on('end', async () => {
  await waitFor(1500);
  const ffmpeg = createFFmpeg({
    log: true,
  });

  await ffmpeg.load();
  ffmpeg.FS('writeFile', 'video.mp4', await fetchFile( output ));
  await ffmpeg.run('-i', 'video.mp4', '-acodec', 'libmp3lame', '-b:a', '192k', '-vn', '-f', 'mp3', 'flame.mp3');
  await fs.promises.writeFile('flame.mp3', ffmpeg.FS('readFile', 'flame.mp3'));
  // await fs.promises.unlink(output)
  process.exit(0);
});

ytdl(url).pipe(fs.createWriteStream(output));

// ffmpeg -i C:\Users\paul\Downloads\Icarus\Icarus - Killers.flac -acodec libmp3lame -b:a 96k -vn -f mp3 pipe:1