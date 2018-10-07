**Share a Playlist**
----
  Generates an access token for a shared playlist and saves the token/playlist under a UUID for easy retrieval

* **URL**

  /shared/make-shared

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `shareTimeInDays` - Token will expire after this period of time<br />
   `playlist` - Playlist that will be shared


* **JSON Example**

  ```
  {
    'shareTimeInDays': 14,
    'playlist': ['/path/to/song1.mp3', '/path/to/song2/mp3']
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      'playlist_id': 'UUID_SRING',
      'token': 'TOKEN_STRING'
    }
    ```