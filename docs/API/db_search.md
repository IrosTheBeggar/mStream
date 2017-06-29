**Search DB**
----
  Retrieves albums and artists that much a given string

* **URL**

  /db/search

* **Method:**

  `POST`

* **JSON Params**

   **Required:**

   `search` - String that will be searched for

* **JSON Example**

  ```
  {
    'search': 'The Offsp'
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      "albums":[album1, album2],
      "artists":[artist1, artist2, artist3]
    }
    ```
