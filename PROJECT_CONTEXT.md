# Nextcloud Enterprise — وضعیت پروژه

## محیط
- سرور: Ubuntu 22.04, IP: 192.168.10.147
- DC: 192.168.10.150, دامین: cltpmo.ir
- مسیر پروژه: ~/nextcloud
- GitHub: https://github.com/777para2x777-Cs/nextcloud-enterprise.git

## Stack
- Nginx → 3x App (Nextcloud 30 FPM) → PgBouncer → PostgreSQL Primary + 2 Replica
- Redis Master + 2 Replica + 3 Sentinel
- Multi-AV: ClamAV + Yara → av_scanner:3311
- AV Dashboard: :8090 (admin/PMO@123456)
- Topology Monitor: :3002
- Monitoring: Prometheus + Grafana

## وضعیت فعلی
- همه سرویس‌ها آنلاین
- collector_pos.txt در /data (persistent)
- topology dynamic SVG از Docker API + Prometheus
- Git push شده

## مشکلات حل شده
- collector pos file persistent شد
- cicap حذف شد
- topology dynamic شد
- AV dashboard auth فعال شد
- ZIP upload برای Yara rules

## PENDING
- تست reboot نهایی
