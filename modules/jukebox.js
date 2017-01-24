// TODO: Properly integrate this
//https://gist.github.com/martinsik/2031681

// Websocket Server
const WebSocketServer = require('ws').Server;



// list of currently connected clients (users)
var clients = { };


exports.setup = function(mstream, server, program){
  const wss = new WebSocketServer({ server: server });
  // This callback function is called every time someone
  // tries to connect to the WebSocket server
  wss.on('connection', function(connection) {

    // accept connection - you should check 'request.origin' to make sure that
    // client is connecting from your website
    // var connection = request.accept(null, request.origin);
    console.log((new Date()) + ' Connection accepted.');


    // Generate code and assure it doesn't exist
    var code;
    var n = 0;
    while (true) {
      code = Math.floor(Math.random()*90000) + 10000;
      if(!(code in clients)){
        break;
      }
      if(n === 10){
        console.log('Failed to create ID for jukebox.');
        // FIXME: Close connection
        return;
      }
      n++;
    }

    // Send Code
    connection.send(JSON.stringify( { code: code} ));
    // Add code to clients object
    clients[code] = connection;


    // user sent some message
    connection.on('message', function(message) {
      if (message.type === 'utf8') { // accept only text
        // Send client code back
        connection.send(JSON.stringify( { code: code} ));

        // FIXME: Will need some work to add more commands
      }
    });

    // user disconnected
    connection.on('close', function(connection) {
      // Remove client from array
      delete clients[code];
    });

  });



  // TODO: Get Album Art calls
  mstream.post( '/push-to-client', function(req, res){
    // Get client id
    console.log(req.body.json);
    const json = JSON.parse(req.body.json);
    console.log(json);
    console.log(json.code);
    console.log(json.command);


      // Check if client ID exists
    const clientCode = json.code;
    const command = json.command;
    console.log(clientCode);
    console.log(clientCode);
    console.log(clientCode);
    console.log(command);


    if(!(clientCode in clients)){
      res.status(500).json({ error: 'Client code not found' });
    }

    // TODO: Check if command logic makes sense

    // Push commands to client
    clients[clientCode].send(JSON.stringify({command:command}));

    // Send confirmation back to user
    res.json({ status: 'done' });
  });

}
