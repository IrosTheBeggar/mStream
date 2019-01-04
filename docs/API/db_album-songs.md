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
        {
          "filepath": 'path/to/file.mp3',
          "metadata": {
            "artist": 'Artist',
            "album": 'Greatest Hits',
            "track": 9,
            "title":' Title',
            "year": 1988,
            "album-art": 'album-art-filename.jpg',
            "filename":  file.mp3,
            "hash": "md5 hash"
          }
        },
        ...
      ]
    ```
