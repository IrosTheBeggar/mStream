**Login**
----
  Use this to get a token that can be used to access the rest of the API

* **URL**

  /login

* **Method:**

  `POST`

*  **JSON Params**

   **Required:**

   `username`<br />
   `password`

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
    vpaths: ['path1', 'path2'],
    token: 'REALLY LONG STRING'
  }
  ```

* **Error Response:**

  All errors forward to `/login-failed`
