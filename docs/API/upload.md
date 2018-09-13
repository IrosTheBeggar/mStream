**Upload Files**
----
  This endpoint can be used to upload files.  

* **URL**

  /upload

* **Method:**

  `POST`

*  **Headers**

  The directory to upload the files to must be included in the header `data-location`. If this not set, the call will fail

* **Body**

  Put the files you want to upload in the request body

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**



* **Error Response:**

  * **Code:** 500 NOT FOUND <br />
    **Content:** `{ error: 'Not a directory' }`
