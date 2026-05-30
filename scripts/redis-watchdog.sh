#!/bin/bash
logger "Redis watchdog started"

PASS="PMO@123456"
FAILOVER_SCRIPT="/root/nextcloud/scripts/redis-manual-failover.sh"
LOCK_FILE="/tmp/redis-failover.lock"

find_best_replica() {
  for replica in nc_redis_replica1 nc_redis_replica2; do
    if docker ps --format '{{.Names}}' | grep -q "^${replica}$"; then
      ROLE=$(docker exec $replica redis-cli -a $PASS info replication 2>/dev/null | grep "^role:" | tr -d '\r' | cut -d: -f2)
      if [ "$ROLE" = "slave" ]; then
        echo $replica
        return
      fi
    fi
  done
}

docker exec nc_sentinel1 redis-cli -p 26379 subscribe +switch-master +odown 2>/dev/null | while read type; do
  read event
  if echo "$event" | grep -q "switch-master\|odown"; then
    # lock چک کن
    if [ -f "$LOCK_FILE" ]; then
      logger "Failover already in progress — skipping"
      continue
    fi

    touch "$LOCK_FILE"
    logger "Redis event: $event"
    sleep 3

    if ! docker exec nc_redis_master redis-cli -a $PASS ping 2>/dev/null | grep -q PONG; then
      logger "Master confirmed down — starting failover"
      BEST=$(find_best_replica)
      if [ -n "$BEST" ]; then
        bash $FAILOVER_SCRIPT $BEST
        logger "Auto-failover complete: $BEST is new master"
      else
        logger "ERROR: No suitable replica found"
      fi
    else
      logger "Master recovered — no failover needed"
    fi

    rm -f "$LOCK_FILE"
  fi
done
