The mStream Web Player is the engine behind the webapp.  It comes with these features

* HTML5 streaming
* Song caching for gapless playback.  The player will automatically start caching the next song while the current song is playing
* Designed to be used alongside VueJS


## Installation

To setup the mStream player you just have to add these files to your project

```HTML
<script src="/public/js/lib/howler.core.js"></script>
<script src="/public/js/mstream.player.js"></script>
```

You can now access the mStream Player through the `MSTREAM` object

## The audioData object

When adding a song to the queue you add it in an object form. The object must contain the `url` key in order for it to work with the player.  The webapp also uses the `filepath` key for a few other functions, but it's not necessary for the player to work.

```
  {
    url: "vPath/path/to/song.mp3?token=xxx",
    filepath: "path/to/song.mp3",
    metadata: {
      "artist": "",
      "album": "",
      "track": 1,
      "title": "",
      "year": 1990,
      "album-art": "hash.jpg"
    }
  }
```


## API

**`addSong(audioData)`**

Add a audioData objecct to the bottom of the queue

**`clearAndPlay(audioData)`**

Clears the queue and then adds the audioData object

**`playPause()`**

Toggles playing and pausing of player

**`seek(timeInSeconds)`**

Will skip to the given time in the song

**`seekByPercentage(percentage)`**

Will seek to the correct time based on a percentage.  It's typically easier to use than the normal seek() call

**`toggleRepeat()`**

Toggles the loop feature

**`toggleShuffle()`**

Toggles the shuffle feature

**`clearPlaylist()`**

Removes all songs from the queue

**`nextSong()`**

Goes to next song in queue

**`previousSong()`**

Goes to previous song in queue

**`goToSongAtPosition(position)`**

Starts playing the song at the positon given

**`removeSongAtPosition(position, sanityCheckUrl)`**

Removes song at given position from queue.  If the currently playing song is removed the player  will automatically play the next song

`sanityCheckUrl` can be set to url.  If it doesn't match the URL at the positon given, nothing will happen. Set to false to ski

**`getCurrentSong()`**

Returns the audioData object of the currently playing song

**`resetPositionCache()`**

If you modify the playlist array directly, you need to call this function when finished.  If you're modifying the playlist through any of then you don't need to worry about calling this.


## Data Binding
The `MSTREAM` object has several convenient objects  that can be used for databinding.

#### `positionCache`

```
{
  val: 3
}
```

#### `playlist`

```
[
  { ... audioData0 ...},
  { ... audioData1 ...},
  { ... audioData2 ...}
]
```

#### `playerStats`

```
{
  duration :210,
  currentTime: 120,
  playing: true,
  repeat: false,
  shuffle: true
}
```

## Bugs

Song caching causes some playback issues on mobile.  Need to add code to disable it on mobile browsers
