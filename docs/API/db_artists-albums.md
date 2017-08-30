**Get All Albums for an Artist**
----
  Will retrieve all albums for a given artist name

* **URL**

  /db/artists-albums

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `artist` - artist name


* **JSON Example**

  ```
  {
    'artist': 'Artist Name'
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{ albums: ['Album1', 'Album2', 'Album3'] }`
