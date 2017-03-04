#### Using Docker

Download the Dockerfile, or clone the repository, then run the following
commands:

```shell
docker build -t local/mstream .

docker run --rm -v /path/to/my/music:/music local/mstream
```

The ENTRYPOINT is `mstream`, so you can use the same option as if using the
default installation.

```shell
docker run --rm -v /path/to/my/music:/music local/mstream -l -u username -x password
```
