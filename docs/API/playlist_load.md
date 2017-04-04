**Load Playlist**
----
  Load a playlist

* **URL**

  /playlist/load

* **Method:**

  `POST`

*  **Request Params**

   **Required:**
   `playlistname` - The name of the playlist


* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `[{filepath: 'path/to/file1.mp3', metadata: ''}, {filepath: 'path/to/file2.flac', metadata: ''}]`

    metadata fields are currently blank. A cache layer needs to be built before it's fast enough to lookup metadata for an entire playlists
