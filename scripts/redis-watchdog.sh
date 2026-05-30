#!/bin/bash
logger "Redis watchdog v4 started"
PASS="PMO@123456"
FAILOVER_SCRIPT="/root/nextcloud/scripts/redis-manual-failover.sh"
LOCK="/tmp/redis-failover.lock"
FAIL_COUNT=0
FAIL_THRESHOLD=3

find_best_replica() {
  for replica in nc_redis_replica1 nc_redis_replica2; do
    if docker ps --format '{{.Names}}' | grep -q "^${replica}$"; then
      ROLE=$(docker exec $replica redis-cli -a $PASS info replication 2>/dev/null | grep "^role:" | tr -d '\r' | cut -d: -f2)
      if [ "$ROLE" = "slave" ] || [ "$ROLE" = "master" ]; then
        echo $replica
        return
      fi
    fi
  done
}

while true; do
  sleep 5

  # lock چک کن
  if [ -f "$LOCK" ]; then
    FAIL_COUNT=0
    continue
  fi

  # current master کیه
  CURRENT=$(cat /tmp/redis-current-master 2>/dev/null || echo "nc_redis_master")

  # چک کن nc_redis_master اگه restart شد و master شد ولی current چیز دیگه‌ایه
  if [ "$CURRENT" != "nc_redis_master" ] && docker ps --format '{{.Names}}' | grep -q "^nc_redis_master$"; then
    ROLE=$(docker exec nc_redis_master redis-cli -a $PASS info replication 2>/dev/null | grep "^role:" | tr -d '\r' | cut -d: -f2)
    if [ "$ROLE" = "master" ]; then
      CURRENT_IP=$(docker inspect $CURRENT --format='{{(index .NetworkSettings.Networks "nextcloud-enterprise_backend").IPAddress}}' 2>/dev/null)
      if [ -n "$CURRENT_IP" ]; then
        docker exec nc_redis_master redis-cli -a $PASS slaveof $CURRENT_IP 6379 2>/dev/null
        logger "watchdog: nc_redis_master auto-slaved to $CURRENT"
      fi
    fi
  fi

  # master زنده‌ست؟
  if docker exec $CURRENT redis-cli -a $PASS ping 2>/dev/null | grep -q PONG; then
    FAIL_COUNT=0
    continue
  fi

  FAIL_COUNT=$((FAIL_COUNT + 1))
  logger "watchdog: $CURRENT not responding ($FAIL_COUNT/$FAIL_THRESHOLD)"

  if [ $FAIL_COUNT -ge $FAIL_THRESHOLD ]; then
    logger "watchdog: $CURRENT confirmed DOWN — auto-failover"
    BEST=$(find_best_replica)
    if [ -n "$BEST" ] && [ "$BEST" != "$CURRENT" ]; then
      logger "watchdog: failing over to $BEST"
      bash $FAILOVER_SCRIPT $BEST
      logger "watchdog: failover complete → $BEST"
    else
      logger "watchdog: ERROR no replica available"
    fi
    FAIL_COUNT=0
  fi
done
