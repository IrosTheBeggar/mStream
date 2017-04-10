**Get Metadata From DB **
----
  Retrieves albums and artists that much a given string

* **URL**

  /db/metadata

* **Method:**

  `POST`

* **JSON Params**

   **Required:**

   `filepath` - String that will be searched for

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
      "artist": "",
      "album": "",
      "track": 1,
      "title": "",
      "year": 1990,
      "album-art": "hash.jpg"
    }
    ```
