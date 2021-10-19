#! /bin/sh
### BEGIN INIT INFO
# Provides: mstream
# Required-Start: $remote_fs $syslog
# Required-Stop: $remote_fs $syslog
# Default-Start: 2 3 4 5
# Default-Stop: 0 1 6
# Short-Description: mstream
# Description: This file starts and stops mstreamserver
# 
### END INIT INFO

MSTREAM_DIR=/home/joe/programs/apache-tomcat-8.0.5/

case "$1" in
 start)
   su joe -c $MSTREAM_DIR/bin/startup.sh
   ;;
 stop)
   su joe -c $MSTREAM_DIR/bin/shutdown.sh
   sleep 10
   ;;
 restart)
   su joe -c $MSTREAM_DIR/bin/shutdown.sh
   sleep 20
   su joe -c $MSTREAM_DIR/bin/startup.sh
   ;;
 *)
   echo "Usage: mstream{start|stop|restart}" >&2
   exit 3
   ;;
esac
