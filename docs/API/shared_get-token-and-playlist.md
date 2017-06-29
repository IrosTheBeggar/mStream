**Get Shared Token and Playlist**
----
  Retrieves the playlist and access token for a shared playlist.  The access token given restricts the user to access only the files in the playlist

* **URL**

  /shared/get-token-and-playlist

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `tokenid` - This is the ID needed to get the token and playlist

* **JSON Example**

  ```
  {
    'tokenid': 'abc-123'
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      token: 'REALLY LONG STRING',
      playlist: ['/path/to/file1.mp3', /path/to/file2.mp3],
      vPath: 'RANDOM STRING'
    }
    ```

* **NOTE:**

  The playlist structure may change in the future to add metadata.
