node-nat-pmp
============
### Node.js implementation of the [NAT Port Mapping Protocol][wikipedia]

This module offers an implementation of the [NAT-PMP][protocol] written in
pure JavaScript. You can use this module to dynamically open and close arbitrary
TCP and UDP ports against the network's internet gateway device.


Installation
------------

Install with `npm`:

``` bash
$ npm install nat-pmp
```


Examples
--------

``` js
var natpmp = require('nat-pmp');

// create a "client" instance connecting to your local gateway
var client = natpmp.connect('10.0.1.1');


// explicitly ask for the current external IP address
client.externalIp(function (err, info) {
  if (err) throw err;
  console.log('Current external IP address: %s', info.ip.join('.'));
});


// setup a new port mapping
client.portMapping({ private: 22, public: 2222, ttl: 3600 }, function (err, info) {
  if (err) throw err;
  console.log(info);
  // {
  //   type: 'tcp',
  //   epoch: 8922109,
  //   private: 22,
  //   public: 2222,
  //   ...
  // }
});
```


API
---




License
-------

(The MIT License)

Copyright (c) 2012 Nathan Rajlich &lt;nathan@tootallnate.net&gt;

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


[wikipedia]: http://wikipedia.org/wiki/NAT_Port_Mapping_Protocol
[protocol]: http://tools.ietf.org/html/draft-cheshire-nat-pmp-03
