#!/bin/bash
# sentinel این script را بعد از failover صدا میزنه
# متغیرها از sentinel میان: $1=master-name $2=oldip $3=oldport $4=newip $5=newport

MASTER_NAME=$1
NEW_MASTER_IP=$4
NEW_MASTER_PORT=$5

logger "Redis failover: $MASTER_NAME → new master: $NEW_MASTER_IP:$NEW_MASTER_PORT"

# nc_redis_master را به master جدید وصل کن
docker exec nc_redis_master redis-cli -a PMO@123456 slaveof $NEW_MASTER_IP $NEW_MASTER_PORT 2>/dev/null

# app nodes را restart کن تا session‌ها reset بشن
sleep 5
docker restart nc_app1 nc_app2 nc_app3

logger "Redis failover complete — app nodes restarted"
