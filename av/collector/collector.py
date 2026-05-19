import time, json, requests, os, urllib.parse

LOG_FILE = "/nextcloud/nextcloud.log"
POS_FILE = "/data/collector_pos.txt"
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://av_dashboard:3000")
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "PMO@123456")

def load_pos():
    try:
        with open(POS_FILE) as f:
            return int(f.read().strip())
    except:
        # اول بار — برو به آخر فایل
        try:
            return os.path.getsize(LOG_FILE)
        except:
            return 0

def save_pos(pos):
    with open(POS_FILE, 'w') as f:
        f.write(str(pos))

def send(data):
    try:
        requests.post(f"{DASHBOARD_URL}/api/scan-result",
            auth=(DASHBOARD_USER, DASHBOARD_PASS),
            json=data, timeout=5)
    except: pass

def parse_and_send():
    pos = load_pos()
    try:
        size = os.path.getsize(LOG_FILE)
        # اگه فایل rotate شد
        if size < pos:
            pos = 0
        if size == pos:
            return
        with open(LOG_FILE, 'r') as f:
            f.seek(pos)
            lines = f.readlines()
            pos = f.tell()
        save_pos(pos)
        for line in lines:
            try:
                e = json.loads(line)
                msg = e.get('message','').strip()
                url = e.get('url','')
                user = e.get('user','--')
                method = e.get('method','')
                if user in ('--', 'nextcloud'): continue
                filename = urllib.parse.unquote(url.split('/')[-1]) if url and url != '--' else 'unknown'
                if msg == 'Response :: stream: OK' and method == 'PUT':
                    send({'filename': filename, 'infected': False, 'engine': 'ClamAV + Yara', 'user': user, 'quarantined': False})
                    print(f"CLEAN: {filename} ({user})")
                elif 'Response :: stream:' in msg and 'FOUND' in msg:
                    threat = msg.replace('Response :: stream: ','').replace(' FOUND','')
                    send({'filename': filename, 'infected': True, 'threat': threat, 'engine': 'ClamAV + Yara', 'user': user, 'quarantined': False})
                    print(f"INFECTED: {filename} - {threat} ({user})")
            except: pass
    except Exception as e:
        print(f"Error: {e}")

print("Log collector started (position-based)...")
while True:
    parse_and_send()
    time.sleep(5)
