#!/bin/bash
NEW_MASTER=${1:-nc_redis_replica1}
PASS="PMO@123456"
LOCK="/tmp/redis-failover.lock"
ALL="nc_redis_master nc_redis_replica1 nc_redis_replica2"
NETWORK="nextcloud-enterprise_backend"

if [ -f "$LOCK" ]; then echo "Already running"; exit 1; fi
touch "$LOCK"
trap "rm -f $LOCK" EXIT

echo "=== Redis Failover: $NEW_MASTER ==="

# 1. promote
docker exec $NEW_MASTER redis-cli -a $PASS slaveof no one 2>/dev/null
sleep 2
docker exec $NEW_MASTER redis-cli -a $PASS config set replica-read-only no 2>/dev/null
echo "✓ $NEW_MASTER → master"

# 2. proxy آپدیت — فقط container را recreate کن
docker rm -f redis_socat 2>/dev/null
docker run -d \
  --name redis_socat \
  --network $NETWORK \
  --network-alias redis_master \
  --restart unless-stopped \
  alpine/socat \
  TCP-LISTEN:6379,fork,reuseaddr TCP:$NEW_MASTER:6379
sleep 2
echo "✓ redis_master proxy → $NEW_MASTER"

# 3. flush
docker exec $NEW_MASTER redis-cli -a $PASS flushall 2>/dev/null
echo "✓ cache flushed"

# 4. IP master جدید
NEW_IP=$(docker inspect $NEW_MASTER --format='{{(index .NetworkSettings.Networks "nextcloud-enterprise_backend").IPAddress}}')

# 5. بقیه را slave کن
for node in $ALL; do
  if [ "$node" != "$NEW_MASTER" ]; then
    if docker ps --format '{{.Names}}' | grep -q "^${node}$"; then
      docker exec $node redis-cli -a $PASS slaveof $NEW_IP 6379 2>/dev/null
      echo "✓ $node → slave"
    fi
  fi
done

# 6. current master ذخیره کن
echo "$NEW_MASTER" > /tmp/redis-current-master

# 6.1 nc_redis_master را slave کن اگه online شد
if docker ps --format '{{.Names}}' | grep -q "^nc_redis_master$" && [ "$NEW_MASTER" != "nc_redis_master" ]; then
  docker exec nc_redis_master redis-cli -a $PASS slaveof $NEW_IP 6379 2>/dev/null
  echo "✓ nc_redis_master → slave"
fi

# 7. nginx recreate
cd /root/nextcloud
docker rm -f nc_nginx
docker compose up -d nginx
sleep 15
echo "✓ nginx recreated"

# fix: چند بار چک کن nc_redis_master slave بمونه
for i in 1 2 3; do
  sleep 3
  if docker ps --format '{{.Names}}' | grep -q "^nc_redis_master$" && [ "$NEW_MASTER" != "nc_redis_master" ]; then
    ROLE=$(docker exec nc_redis_master redis-cli -a $PASS info replication 2>/dev/null | grep "^role:" | tr -d '' | cut -d: -f2)
    if [ "$ROLE" = "master" ]; then
      NEW_IP2=$(docker inspect $NEW_MASTER --format='{{(index .NetworkSettings.Networks "nextcloud-enterprise_backend").IPAddress}}')
      docker exec nc_redis_master redis-cli -a $PASS slaveof $NEW_IP2 6379 2>/dev/null
      echo "✓ nc_redis_master → slave (attempt $i)"
    fi
  fi
done

echo "=== Result ===" 
for c in $ALL; do
  echo -n "$c: "
  docker exec $c redis-cli -a $PASS info replication 2>/dev/null | grep "^role:" || echo "DOWN"
done
docker exec nc_app1 getent hosts redis_master
curl -sk -o /dev/null -w "Site: %{http_code}\n" --max-time 15 https://localhost/
