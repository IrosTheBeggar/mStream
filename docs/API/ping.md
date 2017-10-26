**Ping**
----
  Used to check if the user is logged in.  Also used to get the vPath

* **URL**

  /ping

* **Method:**

  `GET`

* **Success Response:**

  ```
  {
    vpaths: ['path1', 'path2'],
    guest: false
  }
  ```

  Returns whether user is a guest or not.  Guest accounts don't have write access

* **Error Response:**

 Forwards to `/login-failed` if not logged in
