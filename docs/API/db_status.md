**DB Status**
----
  Checks if a scan is in progress. 

* **URL**

  /db/status

* **Method:**

  `GET`

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      locked: false,
      totalFileCount: 150
    }
    ```

    `locked` will be true if a scan is in progress.  