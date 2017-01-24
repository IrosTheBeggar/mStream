## Skinning

#### Step 1: Download and Setup the Stack
- mstream.player.js and mstream.api.js
- VueJS
- Sortable JS & Vue Draggable
- Aurora and Flac JS
- Howler JS


There's a lot in that stack:
- mstream.player.js creates a global MSTREAM module that contains a fully functional media player and playlist
  - Howler, Aurora, and Flac JS are all dependencies of mstream.player.js
  - You can read the API for this module here: ['TODO: PUT URL HERE']
- mstream.api.js creates a global MSTREAMAPI module that is used to manage and query mStream servers
- VueJS is what we will use to bind the MSTREAM module the HTML
- SortableJS and Vue Draggable add drag and drop functionality to the playlist


Now make an html file with the following
```
<head>
  <!-- mStream CSS -->
  <link rel="stylesheet" href="/public-shared/css/mstream.css">
  <!-- Pure CSS -->
  <link rel="stylesheet" href="https://unpkg.com/purecss@0.6.1/build/pure-min.css" integrity="sha384-CCTZv2q9I9m3UOxRLaJneXrrqKwUNOzZ6NGEUMwHtShDJ+nCoiXJCAgi05KfkLGY" crossorigin="anonymous">

  <!--
  This is the mStream Player stack
    DO NOT Change to order these are loaded in
    You do not need to worry about how these work
          -->
  <script src="/js/aurora.js"></script>
  <script src="/js/flac.js"></script>
  <script src="/js/howler.core.min.js"></script>
  <script src="/js/mstream.js"></script>
  <script src="/js/mstream.api.js"></script>

  <!-- Vue JS -->
  <script src="https://unpkg.com/vue/dist/vue.js"></script>
  <!-- Sortable JS -->
  <script src="https://unpkg.com/sortablejs@latest"></script>
  <!-- https://github.com/SortableJS/Vue.Draggable - v2.6 -->
  <script src="/public-shared/js/vue-sortable.js"></script>

</head>
```


#### Step 2: Make a Playlist
Add the playlist HTML
```
<!-- Playlist -->
<div class="playlist-container">
  <draggable :list="playlist" @end="checkMove"  id="playlist">
    <div v-for="(song, index) in playlist" is="playlist-item" :key="index" :index="index" :text="song.filepath" :active="(index == current) ? 'theclass' : 'noclass'">
    </div>
  </draggable>
</div>
```

There's a lot going on here.  The draggable element is used by Sortable JS to make a the list inside it have drag and drop capability.  The rest of the bizare syntax is used by VueJS

```
// Highlight currently playing song
Vue.component('playlist-item', {
  template: '\
    <div class="playlist-item" v-bind:class="{ playing: (index2 == active2.val) }" >\
     <span  v-on:click="goToSong($event)" class="song-area">{{ text }}</span> <span v-on:click="removeSong($event)" class="removeSong">X</div>\
    </div>\
  ',
  props: ['text', 'active', 'index', 'current', 'drag'],
  data: function(){
    return {
      active2: MSTREAM.positionCache,
      index2: this.index,
    }
  },
  methods: {
    goToSong: function(event){
      MSTREAM.goToSongAtPosition(this.index);
    },
    removeSong: function(event){
      MSTREAM.removeSongAtPosition(this.index, false);
    }
  }
});

// Code to update playlist
var playlistElement = new Vue({
  el: '#playlist',
  data: {
    playlist: MSTREAM.playlist,
    current: MSTREAM.positionCache,
  },
  methods: {
    checkMove: function (event) {
      MSTREAM.resetPositionCache();
    }
  }
});

```
