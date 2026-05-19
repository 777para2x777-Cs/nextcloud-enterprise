# Nextcloud Enterprise — وضعیت پروژه

## محیط
- سرور: Ubuntu 22.04, IP: 192.168.10.147
- DC: 192.168.10.150, دامین: cltpmo.ir
- مسیر پروژه: ~/nextcloud
- GitHub: https://github.com/777para2x777-Cs/nextcloud-enterprise.git

## Stack
- Nginx → 3x App (Nextcloud 30 FPM) → PgBouncer → PostgreSQL Primary + 2 Replica
- Redis Master + 2 Replica + 3 Sentinel
- Multi-AV: ClamAV + Yara → av_scanner:8000
- AV Dashboard: :8090 (admin/PMO@123456)
- Topology Monitor: :3002
- Monitoring: Prometheus + Grafana

## وضعیت فعلی
- همه 26 سرویس آنلاین (PASS: 32 | FAIL: 0 | WARN: 0)
- تست reboot نهایی انجام شد — همه سرویس‌ها auto-start دارند
- collector_pos.txt در /data/docker/volumes/nextcloud-antivirus_dashboard_data/_data (persistent)
- topology dynamic SVG از Docker API + Prometheus
- ClamAV DB آپدیت شد (main.cvd سالم)
- Redis sentinel auth با REDIS_PASSWORD sync شد

## مشکلات حل شده
- collector pos file persistent شد
- cicap حذف شد
- topology dynamic شد
- AV dashboard auth فعال شد
- ZIP upload برای Yara rules
- ClamAV main.cvd corrupted — fix شد
- Redis sentinel پسورد CHANGE_ME → PMO@123456 fix شد
- nc_app4 و test_service حذف شدند
- health check script با container name های واقعی fix شد

## فایل‌های مهم
- Health Check: ~/post_reboot_check.sh (PASS: 32 | FAIL: 0)
- AV Scanner endpoint: :8000 (نه :3311/health)
- ClamAV DB: /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/

## PENDING
- تمام — پروژه آماده production است ✅
