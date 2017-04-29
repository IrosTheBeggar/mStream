// TODO: Function that copies a BeetsDB(private) into the SQLite master(public) DB
const sqlite3 = require('sqlite3').verbose();

// This is designed to run as it's own process
// It takes in a json array
//  {
//    "username":"lol",
//    "privateDBOptions":{
//      "privateDB":"BEETS",
//      "importDB":"path/to/sqlite3.db",
//      "beetspath":"/path/to/beets/music/dir",
//      "quickSync": true
//    },
//    "userDir":"/Users/psori/Desktop/Blockhead",
//    "dbSettings":{
//     "type":"sqlite",
//     "dbPath":"/Users/psori/Desktop/LATESTGREATEST.DB"
//   }
// }


try{
  var loadJson = JSON.parse(process.argv[process.argv.length-1], 'utf8');

}catch(error){
  console.log('Cannot parse JSON input');
  process.exit();
}


const dbPublic = require('../db-write/database-default-'+loadJson.dbSettings.type+'.js');
const beetsDB = new sqlite3.Database(dbPath);

if(loadJson.dbSettings.type == 'sqlite'){
  dbPublic.setup(loadJson.dbSettings.dbPath); // TODO: Pass this in
}


// run();

function runIt(){
  db.serialize(function() {
    // Delete all of users entries in DB
    let sql = "DELETE FROM items WHERE user = ?;";
    db.run(sql, [loadJson.username]);

    // Pull in all entries and add to db
    // ALT: ATTACH DATABASE "myother.db" AS aDB;
    db.run("attach ? as beetsdb;", [app.getPath('userData') + "/server.db"]);
      // Make sure each entry matched the users music dir
    // let sss = "INSERT INTO items(title, artist, year, album, path, track, disk) SELECT fieldname1, fieldname2 FROM beetsdb.items;"


    let ggg = "INSERT INTO items ( title, artist, year, album, path, track, disk, user )\
                SELECT title, artist, year, album, path, track, disk, ?\
                FROM beetsdb.items";


    db.run(ggg, [loadJson.username]);

      // Scan user's files for album art
  });






}
