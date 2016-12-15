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


run();

    // SELECT * FROM items LEFT JOIN item_attributes ON
    // item_attributes.entity_id = items.id
    // AND item_attributes.key = 'checksum'
    // GROUP BY items.id, item_attributes.key;
function run(){

  let sql = "SELECT * FROM items LEFT JOIN item_attributes ON item_attributes.entity_id = items.id AND item_attributes.key = 'checksum' GROUP BY items.id, item_attributes.key;";
  beetsDB.all(sql, function(err, files){
      files = dbPublic.reformatData(files);

      // TODO: We can make this more efficient by comparing the differences and just adding/deleting the changes
      dbPublic.purgeDB(username);

      dbPublic.addToDB(files);

      if(loadJson.privateDBOptions.quickSync === false){
        smokeThatHash();
      }
  });
}


function insertEntries(numberToInsert = 99, loopToEnd = false){
  var insertThese = [];

  while(insertThese.length != numberToInsert ){
    if(arrayOfSongs.length == 0){
      break;
    }
    insertThese.push(arrayOfSongs.pop());
  }

  dbRead.insertEntries(insertThese, loadJson.username, function(){
    // Recursivly run this function until all songs have been added
    if(loopToEnd && arrayOfSongs.length != 0){
      insertEntries(numberToInsert, true);
    }else{
      // For the generator
      parseFilesGenerator.next();
    }
  });
}


// TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:
function smokeThatHash( blazeItEveryDay = false){

  // Pull all files from DB
      // Get hash
      // Update DB


    // if hash is available or blazeItEveryDay=true then hash file
    // TODO: Shoudl we add the hash to the beets DB?
}
// TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:TODO:
