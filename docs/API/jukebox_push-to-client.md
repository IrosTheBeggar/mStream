**Push Message To Jukebox Instance**
----
  Send a message to a client running in Jukebox Mode

* **URL**

  /jukebox/push-to-client

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `code` - This is the code generated when starting Jukebox Mode<br/>
   `command` - Command to push to client

   **Optional:**

   `file` - filepath for adding files to playlist

* **JSON Example**

  ```
  {
    'code': '59305',
    'command': 'addSong',
    'file': '/path/to/file.flac'
  }
  ```

* **List Of Commands**

  If the command does not match one of the following, the server will return an error

  - `next`
  - `previous`
  - `playPause`
  - `addSong`
  - `getPlaylist` (not currently implemented)
  - `removeSong` (not currently implemented)

  Users with Guest Codes will only have access to `addSong` and `getPlaylist`


* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
      { status: 'done' }
    ```

* **NOTES:**

  - Additional functions to limit guest access will be added in the future
  - Returns a 500 error if the client code could not be found
