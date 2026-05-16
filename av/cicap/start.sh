#!/bin/bash
mkdir -p /var/run/c-icap /var/log/c-icap
chmod 777 /var/run/c-icap /var/log/c-icap

CLAMAV_IP=$(getent hosts clamav | awk '{print $1}' | head -1)
if [ -z "$CLAMAV_IP" ]; then CLAMAV_IP="127.0.0.1"; fi
echo "Connecting to ClamAV at $CLAMAV_IP:3310"

cat > /etc/c-icap/c-icap.conf << CONF
ServerName cicap
Port 1344
MaxServers 5
MinSpareThreads 5
MaxSpareThreads 10
ThreadsPerChild 5
TmpDir /tmp
MaxMemObject 131072
ModulesDir /usr/lib/x86_64-linux-gnu/c_icap
ServicesDir /usr/lib/x86_64-linux-gnu/c_icap
Module common clamd_mod.so
clamd_mod.ClamdSocket tcp:${CLAMAV_IP}:3310
Include /etc/c-icap/virus_scan.conf
CONF

exec c-icap -N -D -f /etc/c-icap/c-icap.conf
