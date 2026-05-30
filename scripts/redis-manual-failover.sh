#!/bin/bash
# Redis Manual Failover Script
# Usage: ./redis-manual-failover.sh [nc_redis_replica1|nc_redis_replica2]

NEW_MASTER=${1:-nc_redis_replica1}
PASS="PMO@123456"
OTHER=$([ "$NEW_MASTER" = "nc_redis_replica1" ] && echo "nc_redis_replica2" || echo "nc_redis_replica1")

echo "=== Redis Manual Failover ==="
echo "New master: $NEW_MASTER"

# 1. promote
docker exec $NEW_MASTER redis-cli -a $PASS slaveof no one
sleep 2
echo "✓ $NEW_MASTER promoted to master"

# 2. redis_master proxy را به master جدید هدایت کن
cd /root/nextcloud
docker rm -f redis_master
sed -i "s|TCP:nc_redis_master:6379|TCP:$NEW_MASTER:6379|g" docker-compose.yml
docker compose up -d redis_master_proxy
sleep 3
echo "✓ redis_master proxy → $NEW_MASTER"

# 3. flush Redis
docker exec $NEW_MASTER redis-cli -a $PASS flushall 2>/dev/null
echo "✓ Redis cache flushed"

# 4. replica دیگر را slave کن
NEW_IP=$(docker inspect $NEW_MASTER --format='{{(index .NetworkSettings.Networks "nextcloud-enterprise_backend").IPAddress}}')
docker exec $OTHER redis-cli -a $PASS slaveof $NEW_IP 6379 2>/dev/null
echo "✓ $OTHER → slave"

# nc_redis_master را slave کن اگه online باشه
if docker ps --format '{{.Names}}' | grep -q "^nc_redis_master$"; then
  docker exec nc_redis_master redis-cli -a $PASS slaveof $NEW_IP 6379 2>/dev/null
  echo "✓ nc_redis_master → slave"
fi

echo "=== Result ==="
for c in nc_redis_master nc_redis_replica1 nc_redis_replica2; do
  echo -n "$c: "
  docker exec $c redis-cli -a $PASS info replication 2>/dev/null | grep "^role:"
done

curl -sk -o /dev/null -w "Site: %{http_code}\n" --max-time 15 https://localhost/
