**Login**
----
  Use this to get a token that can be used to access the rest of the API

* **URL**

  /login

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `username` - directory to get contents from<br />
   `password` - directory to get contents from

* **JSON Example**

  ```
  {
    'username': 'root',
    'password': 'qwerty'
  }
  ```

* **Success Response:**

  ```
  {
    success: true,
    message: 'Welcome To mStream',
    vPath: 'MEDIUM LENGTH STRING',
    token: 'REALLY LONG STRING'
  }
  ```

* **Error Response:**

  All errors forward to `/login-failed`
