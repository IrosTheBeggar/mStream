**Get Metadata From DB**
----
  Retrieves albums and artists that match a given string

* **URL**

  /db/metadata

* **Method:**

  `POST`

* **JSON Params**

   **Required:**

   `filepath` - filepath of song

* **JSON Example**

  ```
  {
    'filepath': '/path/to/file'
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      "filepath":"/path/to/file.mp3",
      "metadata":{
        "artist": "Artist",
        "album": "Album",
        "track": 1,
        "title": "Song Title",
        "year": 1990,
        "album-art": "hash.jpg",
        "hash": "md5 hash"
      }
    }
    ```
