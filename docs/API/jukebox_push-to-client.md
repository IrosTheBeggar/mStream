**Push Message To Jukebox Instance**
----
  Send a message to a client running in Jukebox Mode

* **URL**

  /jukebox/push-to-client

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `code` - This is the code generated when starting Jukebox Mode<br />
   `command` - Command to

   **Optional:**

   `file` - filepath for adding files to playlist

* **JSON Example**

  ```
  {
    'code': '59305',
    'command': 'addSong',
    file: '/path/to/file.flac'
  }
  ```

* **List Of Commands**

  If the command does not match one of the following, the server will return an error

  - `next`
  - `previous`,
  - `playPause`,
  - `addSong`,
  - `getPlaylist`,
  - `removeSong`,

  Users with Guest Codes will only have access to `addSong` and `getPlaylist`


* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      'id': 'UUID_SRING',
      'token': 'TOKEN_STRING',
      'experiationdate':'TODO'
    }
    ```

* **NOTES:**

  - The `getPlaylist` command not yet implemented
  - Additional functions to limit guest access will be added in the future
