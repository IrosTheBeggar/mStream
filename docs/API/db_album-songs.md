**Get Songs for Album**
----
  Will retrieve all songs and metadata for a given album name

* **URL**

  /db/album-songs

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `album` - Album Name

* **JSON Example**

  ```
  {
    'album': 'Album Name'
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
      [
        {filepath: 'path/to/file.mp3', title: 'Song Name', album: 'Album Name', year:'1990', track:1},
        {filepath: 'path/to/file2.flac', title: 'Song Name', album: 'Album Name', year:'1991', track:1}
      ]
    ```

* **TODO**

  An `artist` param should be added to avoid problems with duplicate album names
