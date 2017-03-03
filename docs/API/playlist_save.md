**Save Playlist**
----
  Save a playlist

* **URL**

  /playlist/save

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `title` - The name of the playlist<br />
   `songs` - Array of filepaths to save.  I recommend removing the vPath before saving

* **JSON Example**

  ```
  {
    'title': 'New Playlist',
    'songs': [ 'path/to/song1.mp3', 'path/to/song2.mp3' ]
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{success: true}`
