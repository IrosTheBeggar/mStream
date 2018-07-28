Writing JSON config files by hand is tedious and leads to errors.  mStream comes with a command line tools to manage your config file.  

## Init

Use the `--init` flag to generate a json file or reset the file to an empty state

```
mstream --init config.json
```

## Add a folder

```
mstream -j config.json --addpath /path/to/music
```

## Add a user

You need to add a folder before adding users

```
mstream -j config.json --adduser
```

## Change Port

```
mstream -j config.json --editport
```

## Generate Secret

The secret is used to sign all JSON Web Tokens. If you don't have a secret, a random one will be generated on server boot and all previous JWTs will be invalidated.  Having a secret in the config will keep JWTs valid between server reboots

```
mstream -j config.json --makesecret
```

## Add SSL Key

```
mstream -j config.json --addkey /path/to/key
```

## Add SSL Cert

```
mstream -j config.json --addcert /path/to/cert
```

## Delete User

```
mstream -j config.json --removeuser
```

## Remove Folder

```
mstream -j config.json --removepath
```