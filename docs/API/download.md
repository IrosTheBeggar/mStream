**Download Files**
----
  Will zip files up and them download the zip file

* **URL**

  /download

* **Method:**

  `POST`

*  **Params**

  The download endpoint gets the list of files to download through the POST param `fileArray`.  The reason for this is due to the finicky way some browsers handle downloads.

* **JSON Example**

  ```
  ['path/to/file1.mp3', path/to/file2.flac]
  ```

* **Success Response:**

  Will download a zip file
