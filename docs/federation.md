## How It Works

mStream simply manages the SyncThing config file and adds an API that tries to simplify the process as much as possible.

The first path to syncing involves trading IDs.  

The second path involve using the web service.  You can

## Known Issues
- SyncThing will overwrite the config.xml file if it has a different config
- You have to hit the `restart` api right after saving a the config file

## Future Enhancements

#### Pool Federated Devices

The device that owns the federated directory should be able to let all sharing devices know of the existence of other sharing devices.  This way those devices can all federate together and strengthen the network

#### Read/Write sharing

User should be able to put directories in read/write mode so federated instances can pish changes upwards

#### Federate Users

Share user date between servers.  Would be a separate process from federating a directory