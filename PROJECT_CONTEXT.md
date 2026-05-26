# Nextcloud Enterprise — وضعیت پروژه

## محیط
- سرور: Ubuntu 22.04, IP: 192.168.10.147
- DC: 192.168.10.150, دامین: cltpmo.ir
- مسیر پروژه: ~/nextcloud
- GitHub: https://github.com/777para2x777-Cs/nextcloud-enterprise.git

## Stack
- Nginx → 3x App (Nextcloud 30 FPM) → PgBouncer → PostgreSQL Primary + 2 Replica
- Redis Master + 2 Replica + 3 Sentinel + HAProxy (nc_redis_proxy :6380)
- Multi-AV: ClamAV + Yara → av_scanner:8000
- AV Dashboard: :8090 (admin/PMO@123456)
- Topology Monitor: :3002
- Architecture Dashboard: :3003
- Monitoring: Prometheus + Grafana

## وضعیت فعلی
- همه سرویس‌ها آنلاین
- Nextcloud به Redis از طریق HAProxy (nc_redis_proxy:6380) وصله
- HAProxy با resolvers docker کار می‌کنه — crash نمی‌کنه
- sentinel.conf در /data/docker/sentinel/sentinel1/2/3 ذخیره میشه (writable)
- Architecture Dashboard با Smart Diagnostics + Auto-Remediation فعاله

## مشکلات حل شده
- Redis failover باعث down شدن سایت میشد → HAProxy proxy اضافه شد
- sentinel.conf read-only بود → منتقل به /data/docker/sentinel/
- config.php ownership بعد از docker cp عوض میشد → chown بعد از کپی
- ClamAV DB corrupted → freshclam fix
- Redis sentinel پسورد اشتباه → fix شد

## PENDING
- sentinel master discovery هنوز مشکل داره — بعد از restart sentinel IP را گم می‌کنه
- باید بررسی بشه چرا sentinel slaves را نمی‌بینه

## فایل‌های مهم
- Health Check: ~/post_reboot_check.sh
- HAProxy config: /root/nextcloud/conf/haproxy/redis.cfg
- Sentinel configs: /data/docker/sentinel/sentinel1/2/3/sentinel.conf
- Architecture Dashboard: /root/nextcloud/av/archdash/

## Redis HA Architecture
Nextcloud → nc_redis_proxy:6380 (HAProxy)
HAProxy → nc_redis_master:6379 (role:master check)
HAProxy → nc_redis_replica1:6379 (backup)
HAProxy → nc_redis_replica2:6379 (backup)
Sentinel monitors master و failover خودکار انجام میده
