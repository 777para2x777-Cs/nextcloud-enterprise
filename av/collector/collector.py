import time, json, requests, os, urllib.parse

LOG_FILE = "/nextcloud/nextcloud.log"
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://av_dashboard:3000")
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "PMO@123456")
last_pos = 0
processed_req_ids = set()

def send(data):
    try:
        requests.post(f"{DASHBOARD_URL}/api/scan-result", auth=(DASHBOARD_USER, DASHBOARD_PASS), json=data, timeout=5)
    except: pass

def parse_and_send():
    global last_pos, processed_req_ids
    try:
        with open(LOG_FILE, 'r') as f:
            f.seek(last_pos)
            lines = f.readlines()
            last_pos = f.tell()
        for line in lines:
            try:
                e = json.loads(line)
                msg = e.get('message','').strip()
                url = e.get('url','')
                user = e.get('user','--')
                req_id = e.get('reqId','')
                method = e.get('method','')
                if req_id in processed_req_ids: continue
                filename = urllib.parse.unquote(url.split('/')[-1]) if url and url != '--' else 'unknown'
                if msg == 'Response :: stream: OK' and method == 'PUT' and url != '--' and user != '--' and user != 'nextcloud':
                    processed_req_ids.add(req_id)
                    send({'filename': filename, 'infected': False, 'engine': 'ClamAV + Yara', 'user': user, 'quarantined': False})
                    print(f"CLEAN: {filename}")
                elif 'Response :: stream:' in msg and 'FOUND' in msg:
                    processed_req_ids.add(req_id)
                    threat = msg.replace('Response :: stream: ','').replace(' FOUND','')
                    send({'filename': filename, 'infected': True, 'threat': threat, 'engine': 'ClamAV + Yara', 'user': user, 'quarantined': False})
                    print(f"INFECTED: {filename} - {threat}")
            except: pass
        if len(processed_req_ids) > 10000:
            processed_req_ids = set(list(processed_req_ids)[-5000:])
    except Exception as e:
        print(f"Error: {e}")

print("Log collector started...")
while True:
    parse_and_send()
    time.sleep(5)
