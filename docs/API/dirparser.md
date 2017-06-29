**Get Directory Contents**
----
  Used to make a file browser.  Dirparser will only return contents that are music files or other directories.   Users will not be able to see any other files

* **URL**

  /dirparser

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `dir` - directory to get contents from

   **Optional:**

   `filetypes` - limit filetypes of returned responses.  Useful is your platform does not support all filetypes

* **JSON Example**

  ```
  {
    'dir':'current/directory/',
    'filetypes':['mp3', 'wav', 'flac']
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      path: 'current/directory/',
      contents: [{ type: 'directory', name: 'folder1'}, { type: 'mp3', name: 'file1.mp3'}]
    }
    ```

    'type' will either be 'directory' or the file extension.

* **Error Response:**

  * **Code:** 500 NOT FOUND <br />
    **Content:** `{ error: 'Not a directory' }`
