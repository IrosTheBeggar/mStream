**Delete Playlist**
----
  Delete a playlist

* **URL**

  /playlist/delete

* **Method:**

  `POST`

*  **JSON Params**

  **Required:**

  `playlistname` - The name of the playlist<br />

  **Optional:**

  `hide` - Boolean Value -  If set the playlist will not be deleted but set to a status of 'hidden'.

* **JSON Example**

  ```
  {
    'playlistname': 'Best of Bieber',
    'hide': false
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{success: true}`
