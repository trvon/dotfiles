#!/bin/bash
while [ 1 ]; do
	ps aux | grep /bin | grep apache | awk '{print $2}' | xargs -I {} kill  {}
	ps aux | grep /bin/dbus | awk '{print $2}' | xargs -I {} kill  {}
	sleep 3;
done