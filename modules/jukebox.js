// Websocket Server
const WebSocketServer = require('ws').Server;
const fe = require('path');


// list of currently connected clients (users)
var clients = { };
// Any code in here will be limitted in functionality
var guests = { };


const allowedCommands = [
  'next',
  'previous',
  'playPause',
  'addSong',
  'getPlaylist',
  'removeSong',
];

const guestCommands = [
  'addSong',
  'getPlaylist'
];


exports.setup = function(mstream, server, program){

  const wss = new WebSocketServer({ server: server });
  // This callback function is called every time someone
  // tries to connect to the WebSocket server
  // TODO: Add authentication step with jwt if necessary
  // TODO: https://gist.github.com/jfromaniello/8418116 
  wss.on('connection', function(connection) {

    // accept connection - you should check 'request.origin' to make sure that
    // client is connecting from your website
    console.log((new Date()) + ' Connection accepted.');


    // Generate code and assure it doesn't exist
    var code = createAccountNumber(10000);
    var guestcode = createAccountNumber(10000);


    // Handle code failures
    if(code === false || guestcode === false){
      connection.send(JSON.stringify( { error: 'Failed To Create Instance'} ));
      return;
    }


    // Add code to clients object
    clients[code] = connection;
    // Connect guest code to standard code
    guests[guestcode] = code;


    // Send Code
    connection.send(JSON.stringify( { code: code, guestCode: guestcode} ));

    // user sent some message
    connection.on('message', function(message) {
      // Send client code back
      connection.send(JSON.stringify( { code: code, guestCode: guestcode} ));
    });


    // user disconnected
    connection.on('close', function(connection) {
      // Remove client from array
      delete guests[guestcode];
      delete clients[code];
    });


  });


  // Function for creating account numbers
  function createAccountNumber(limit = 100000){
    // TODO: Check that limit is reasonably sized integer

    var n = 0;
    while (true) {
      code = Math.floor(Math.random() * (limit * 9)) + limit;
      if(!(code in clients) && !(code in guests)){
        break;
      }
      if(n === 10){
        console.log('Failed to create ID for jukebox.');
        // FIXME: Try again with a larger number size
        return false;
      }
      n++;
    }

    return code;
  }


  // TODO: Get Album Art calls

  // Send codes to client
  mstream.post( '/jukebox/push-to-client', function(req, res){
    // Get client id
    const json = JSON.parse(req.body.json);
    var clientCode = json.code;
    const command = json.command;


    // Check that code exists
    if(!(clientCode in clients) && !(clientCode in guests)){
      res.status(500).json({ error: 'Client code not found' });
      return;
    }

    // TODO: Check if command logic makes sense


    if(clientCode in guests){
      // TODO: Check that command does not vioalt guest conditions

      clientCode = guests[clientCode];
    }


    // Push commands to client
    clients[clientCode].send(JSON.stringify({command:command}));

    // Send confirmation back to user
    res.json({ status: 'done' });
  });



mstream.get('/jukebox/does-code-exist', function(req, res){
  // Get client id
  const json = JSON.parse(req.body.json);
  const clientCode = json.code;

  var status;

  // Check that code exists
  if(!(clientCode in clients) && !(clientCode in guests)){
    re.json({ status: false });

    return;
  }

  var guestStatus = (clientCode in guests);
  res.json({ status: true, guestStatus: guestStatus });
});

}
