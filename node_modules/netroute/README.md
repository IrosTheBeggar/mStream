# Netroute

Route table bindings for node.js

## Usage

```javascript
// Get routes list
require('netroute').getInfo();
/*
 Returns object:
   {
     "IPv4": [{
        "destination": "0.0.0.0",
        "gateway": "192.168.10.1",
        "netmask": "124.0.5.4",
        "mtu": 1500,
        "rtt": 0,
        "expire": 0,
        "interface": "en1"
     }, ...],
     "IPv6": [{
       ...
     }, ...]
   }

  Note: fields may differ on different platforms
  (though gateway, destination, netmask and interface should be always
   available).
*/


// Get default gateway
require('netroute').getGateway(/* optional interface */); // 192.168.1.1
```

### License

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2012.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
