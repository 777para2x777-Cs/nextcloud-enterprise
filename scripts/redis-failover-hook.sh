#!/bin/bash
logger "Redis failover detected — restarting app nodes"
docker restart nc_app1 nc_app2 nc_app3
logger "App nodes restarted after Redis failover"
