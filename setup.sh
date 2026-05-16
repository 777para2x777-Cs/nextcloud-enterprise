#!/bin/bash
# ============================================
# Nextcloud Enterprise - Setup Script
# ============================================

set -e

# ── تنظیمات ──────────────────────────────────
NEW_IP="${1:-$(hostname -I | awk '{print $1}')}"
OLD_IP="192.168.10.147"
DC_IP="192.168.10.150"
BACKUP_PATH="${2:-/backup}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo " Nextcloud Enterprise Setup"
echo " IP: $NEW_IP"
echo " Backup: $BACKUP_PATH"
echo "============================================"

# ── مرحله ۱: Docker ──────────────────────────
echo ""
echo "=== Step 1: Check Docker ==="
if ! command -v docker &>/dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
else
    echo "Docker already installed: $(docker --version)"
fi

# ── مرحله ۲: Docker daemon ───────────────────
echo ""
echo "=== Step 2: Configure Docker daemon ==="
cat > /etc/docker/daemon.json << DAEMON
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "metrics-addr": "0.0.0.0:9323",
  "experimental": true
}
DAEMON
systemctl restart docker
sleep 5
echo "Docker daemon configured"

# ── مرحله ۳: آپدیت IP ها ─────────────────────
echo ""
echo "=== Step 3: Update IP addresses ==="
sed -i "s/$OLD_IP/$NEW_IP/g" $SCRIPT_DIR/docker-compose.yml
sed -i "s/$OLD_IP/$NEW_IP/g" $SCRIPT_DIR/conf/nginx/nextcloud.conf 2>/dev/null || true
echo "IPs updated: $OLD_IP -> $NEW_IP"

# ── مرحله ۴: فایل‌های حساس ───────────────────
echo ""
echo "=== Step 4: Copy sensitive files ==="

# SSL
if [ -d "$BACKUP_PATH/configs/nextcloud/ssl" ]; then
    mkdir -p $SCRIPT_DIR/ssl
    cp -r $BACKUP_PATH/configs/nextcloud/ssl/* $SCRIPT_DIR/ssl/
    echo "SSL certificates copied"
else
    echo "WARNING: SSL certificates not found in backup!"
    echo "Generating self-signed certificate..."
    mkdir -p $SCRIPT_DIR/ssl
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout $SCRIPT_DIR/ssl/key.pem \
        -out $SCRIPT_DIR/ssl/cert.pem \
        -subj "/CN=$NEW_IP"
    echo "Self-signed certificate generated"
fi

# env file
if [ -f "$BACKUP_PATH/configs/nextcloud/.env" ]; then
    cp $BACKUP_PATH/configs/nextcloud/.env $SCRIPT_DIR/.env
    echo ".env copied"
else
    echo "WARNING: .env file not found!"
fi

# فایل‌های حساس
for file in \
    "conf/pgbouncer/userlist.txt" \
    "conf/redis/sentinel.conf" \
    "conf/nextcloud/ldap.config.php" \
    "av/scanner/app/engines_config.json"; do
    SRC="$BACKUP_PATH/configs/nextcloud/$file"
    DST="$SCRIPT_DIR/$file"
    if [ -f "$SRC" ]; then
        mkdir -p "$(dirname $DST)"
        cp "$SRC" "$DST"
        echo "Copied: $file"
    else
        echo "WARNING: $file not found in backup"
    fi
done

# ClamAV signatures
echo ""
echo "=== Step 5: ClamAV signatures ==="
mkdir -p /home/paradox
if ls $BACKUP_PATH/*.cvd &>/dev/null; then
    cp $BACKUP_PATH/*.cvd /home/paradox/
    echo "ClamAV signatures copied"
else
    echo "WARNING: ClamAV signatures not found!"
fi

# ── مرحله ۶: Docker images ───────────────────
echo ""
echo "=== Step 6: Load Docker images ==="
if [ -f "$BACKUP_PATH/all_images.tar" ]; then
    echo "Loading all_images.tar (this may take a while)..."
    docker load -i $BACKUP_PATH/all_images.tar
    echo "all_images loaded"
else
    echo "WARNING: all_images.tar not found - will pull from internet"
fi

if [ -f "$BACKUP_PATH/cicap_v2.tar" ]; then
    docker load -i $BACKUP_PATH/cicap_v2.tar
    echo "cicap image loaded"
else
    echo "Building cicap image..."
    docker build -t local/cicap:v2 $SCRIPT_DIR/av/cicap/
fi

if [ -f "$BACKUP_PATH/scanner_v1.tar" ]; then
    docker load -i $BACKUP_PATH/scanner_v1.tar
    echo "scanner image loaded"
else
    echo "Building scanner image..."
    docker build -t local/scanner:v1 $SCRIPT_DIR/av/scanner/
fi

# ── مرحله ۷: ClamAV volume ───────────────────
echo ""
echo "=== Step 7: Setup ClamAV volume ==="
docker volume create nextcloud-antivirus_clamav_db 2>/dev/null || true
MOUNT=$(docker volume inspect nextcloud-antivirus_clamav_db --format '{{.Mountpoint}}')
if ls /home/paradox/*.cvd &>/dev/null; then
    cp /home/paradox/*.cvd $MOUNT/
    echo "ClamAV signatures restored to volume"
fi

# ── مرحله ۸: راه‌اندازی ──────────────────────
echo ""
echo "=== Step 8: Start Nextcloud stack ==="
cd $SCRIPT_DIR
docker compose up -d
echo "Waiting 40 seconds for services to start..."
sleep 40

echo ""
echo "=== Step 9: Start AV stack ==="
docker compose -f docker-compose.antivirus.yml up -d
sleep 20

# ── مرحله ۹: Fix networks ────────────────────
echo ""
echo "=== Step 10: Fix networks ==="
docker network connect nextcloud-enterprise_backend nc_nginx 2>/dev/null || true
docker network connect nextcloud-enterprise_frontend nc_nginx_exporter 2>/dev/null || true
echo "Networks fixed"

# ── مرحله ۱۰: تنظیم Nextcloud ────────────────
echo ""
echo "=== Step 11: Configure Nextcloud ==="
sleep 10

# trusted domain
docker exec -u www-data nc_app1 php occ config:system:set trusted_domains 0 --value="$NEW_IP" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ config:system:set trusted_domains 1 --value="cloud.cltpmo.ir" 2>/dev/null || true

# loglevel
docker exec -u www-data nc_app1 php occ config:system:set loglevel --value=0 2>/dev/null || true

# AntiVirus
docker exec -u www-data nc_app1 php occ app:enable files_antivirus 2>/dev/null || true
docker exec -u www-data nc_app1 php occ config:app:set files_antivirus av_mode --value=daemon 2>/dev/null || true
docker exec -u www-data nc_app1 php occ config:app:set files_antivirus av_host --value=av_scanner 2>/dev/null || true
docker exec -u www-data nc_app1 php occ config:app:set files_antivirus av_port --value=3311 2>/dev/null || true
docker exec -u www-data nc_app1 php occ config:app:set files_antivirus av_infected_action --value=block 2>/dev/null || true

# LDAP
docker exec -u www-data nc_app1 php occ app:enable user_ldap 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:create-empty-config 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapHost "$DC_IP" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapPort "389" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapAgentName "CN=nc-bind,CN=Users,DC=Cltpmo,DC=ir" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapAgentPassword "PMO@123456" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapBase "DC=Cltpmo,DC=ir" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapBaseUsers "DC=Cltpmo,DC=ir" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapUserFilter "(objectClass=person)" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapLoginFilter "(&(objectClass=person)(sAMAccountName=%uid))" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapUserDisplayName "displayName" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapExpertUsernameAttr "sAMAccountName" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapEmailAttribute "mail" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapPagingSize "500" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapFollowReferrals "0" 2>/dev/null || true
docker exec -u www-data nc_app1 php occ ldap:set-config s01 ldapConfigurationActive "1" 2>/dev/null || true
echo "Nextcloud configured"

# ── مرحله ۱۱: restore volumes ────────────────
echo ""
echo "=== Step 12: Restore volumes ==="
if [ -f "$BACKUP_PATH/nextcloud_data.tar.gz" ]; then
    docker run --rm \
        -v nextcloud-enterprise_nextcloud_data:/data \
        -v $BACKUP_PATH:/backup \
        alpine tar xzf /backup/nextcloud_data.tar.gz -C /
    echo "nextcloud_data restored"
fi
if [ -f "$BACKUP_PATH/grafana_data.tar.gz" ]; then
    docker run --rm \
        -v nextcloud-enterprise_grafana_data:/data \
        -v $BACKUP_PATH:/backup \
        alpine tar xzf /backup/grafana_data.tar.gz -C /
    echo "grafana_data restored"
fi
if [ -f "$BACKUP_PATH/dashboard_data.tar.gz" ]; then
    docker run --rm \
        -v nextcloud-antivirus_dashboard_data:/data \
        -v $BACKUP_PATH:/backup \
        alpine tar xzf /backup/dashboard_data.tar.gz -C /
    echo "dashboard_data restored"
fi

# ── مرحله ۱۲: startup script ─────────────────
echo ""
echo "=== Step 13: Setup startup script ==="
cat > /root/startup.sh << 'STARTUP'
#!/bin/bash
sleep 30
MOUNT=$(docker volume inspect nextcloud-antivirus_clamav_db --format '{{.Mountpoint}}' 2>/dev/null)
[ -n "$MOUNT" ] && cp /home/paradox/*.cvd $MOUNT/ 2>/dev/null
docker image inspect local/cicap:v2 &>/dev/null || docker load -i /home/paradox/cicap_v2.tar
docker image inspect local/scanner:v1 &>/dev/null || docker load -i /home/paradox/scanner_v1.tar
cd /root/nextcloud
docker compose up -d
docker compose -f docker-compose.antivirus.yml up -d
sleep 20
docker network connect nextcloud-enterprise_backend nc_nginx 2>/dev/null || true
docker network connect nextcloud-enterprise_frontend nc_nginx_exporter 2>/dev/null || true
STARTUP
chmod +x /root/startup.sh
grep -v "startup.sh" /etc/crontab > /tmp/crontab_tmp
echo "@reboot root /root/startup.sh >> /var/log/nextcloud-startup.log 2>&1" >> /tmp/crontab_tmp
mv /tmp/crontab_tmp /etc/crontab
echo "Startup script configured"

# ── پایان ────────────────────────────────────
echo ""
echo "============================================"
echo " Setup Complete!"
echo "============================================"
echo " Nextcloud:    https://$NEW_IP"
echo " AV Dashboard: http://$NEW_IP:8090"
echo " Grafana:      SSH tunnel -> localhost:3001"
echo " Prometheus:   SSH tunnel -> localhost:9090"
echo ""
echo " SSH Tunnel command:"
echo " ssh -L 9090:127.0.0.1:9090 -L 3001:127.0.0.1:3000 root@$NEW_IP -N"
echo "============================================"
