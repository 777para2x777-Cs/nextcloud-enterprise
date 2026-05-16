from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import aiohttp
import clamd
import yara
import os
import hashlib
import io
import json
import shutil
from datetime import datetime
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Multi-AV Scanner", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/engines_config.json")
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://av_dashboard:3000")
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "PMO@123456")

def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except:
        return {"engines": []}

def save_config(config):
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)

async def scan_clamav(data: bytes, host: str, port: int) -> dict:
    try:
        cd = clamd.ClamdNetworkSocket(host=host, port=port)
        result = cd.instream(io.BytesIO(data))
        status = result.get('stream', ('OK', None))
        infected = status[0] == 'FOUND'
        return {"engine": f"ClamAV({host}:{port})", "infected": infected, "threat": status[1] if infected else None, "status": "completed"}
    except Exception as e:
        return {"engine": f"ClamAV({host}:{port})", "infected": False, "threat": None, "status": "error", "error": str(e)}

async def scan_yara(data: bytes, rules_path: str) -> dict:
    try:
        rules_files = [f for f in os.listdir(rules_path) if f.endswith(('.yar', '.yara'))]
        if not rules_files:
            return {"engine": "Yara", "infected": False, "threat": None, "status": "no_rules"}
        matches = []
        for rule_file in rules_files:
            try:
                rules = yara.compile(filepath=os.path.join(rules_path, rule_file))
                m = rules.match(data=data)
                if m:
                    matches.extend([str(match) for match in m])
            except Exception as e:
                logger.error(f"Yara rule {rule_file} error: {e}")
        infected = len(matches) > 0
        return {"engine": "Yara", "infected": infected, "threat": ", ".join(matches) if infected else None, "status": "completed"}
    except Exception as e:
        return {"engine": "Yara", "infected": False, "threat": None, "status": "error", "error": str(e)}

async def scan_rest_api(data: bytes, filename: str, url: str, api_key: str = "", method: str = "POST", file_field: str = "file") -> dict:
    try:
        headers = {}
        if api_key:
            headers["x-apikey"] = api_key
        form = aiohttp.FormData()
        form.add_field(file_field, data, filename=filename)
        async with aiohttp.ClientSession() as session:
            async with session.request(method, url, data=form, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                result = await resp.json()
                infected = result.get("infected", False) or result.get("malicious", 0) > 0
                threat = result.get("threat") or result.get("virus_name")
                return {"engine": f"REST({url})", "infected": infected, "threat": threat, "status": "completed", "raw": result}
    except Exception as e:
        return {"engine": f"REST({url})", "infected": False, "threat": None, "status": "error", "error": str(e)}

async def scan_virustotal(data: bytes, filename: str, api_key: str) -> dict:
    if not api_key:
        return {"engine": "VirusTotal", "infected": False, "threat": None, "status": "no_api_key"}
    try:
        file_hash = hashlib.sha256(data).hexdigest()
        async with aiohttp.ClientSession() as session:
            async with session.get(f"https://www.virustotal.com/api/v3/files/{file_hash}", headers={"x-apikey": api_key}) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    stats = result.get("data", {}).get("attributes", {}).get("last_analysis_stats", {})
                    malicious = stats.get("malicious", 0)
                    return {"engine": "VirusTotal", "infected": malicious > 0, "threat": f"{malicious} engines" if malicious > 0 else None, "status": "completed"}
                elif resp.status == 404:
                    form = aiohttp.FormData()
                    form.add_field('file', data, filename=filename)
                    async with session.post("https://www.virustotal.com/api/v3/files", headers={"x-apikey": api_key}, data=form) as r:
                        return {"engine": "VirusTotal", "infected": False, "threat": None, "status": "submitted" if r.status == 200 else "failed"}
    except Exception as e:
        return {"engine": "VirusTotal", "infected": False, "threat": None, "status": "error", "error": str(e)}

async def scan_with_engine(engine: dict, data: bytes, filename: str) -> dict:
    if not engine.get("enabled", True):
        return {"engine": engine["name"], "infected": False, "threat": None, "status": "disabled"}
    
    etype = engine.get("type")
    
    if etype == "clamav":
        return await scan_clamav(data, engine.get("host", "clamav"), int(engine.get("port", 3310)))
    elif etype == "yara":
        return await scan_yara(data, engine.get("rules_path", "/app/rules"))
    elif etype == "virustotal":
        return await scan_virustotal(data, filename, engine.get("api_key", ""))
    elif etype == "rest_api":
        return await scan_rest_api(data, filename, engine.get("url", ""), engine.get("api_key", ""), engine.get("method", "POST"), engine.get("file_field", "file"))
    else:
        return {"engine": engine["name"], "infected": False, "threat": None, "status": "unknown_type"}

async def send_to_dashboard(filename: str, user: str, results: list):
    infected = any(r.get("infected") for r in results)
    threats = [r.get("threat") for r in results if r.get("threat")]
    try:
        async with aiohttp.ClientSession() as session:
            await session.post(
                f"{DASHBOARD_URL}/api/scan-result",
                auth=aiohttp.BasicAuth(DASHBOARD_USER, DASHBOARD_PASS),
                json={"filename": filename, "infected": infected, "threat": ", ".join(threats) if threats else None,
                      "engine": " + ".join([r["engine"] for r in results if r.get("status") == "completed"]),
                      "user": user, "quarantined": False, "details": results}
            )
    except Exception as e:
        logger.error(f"Dashboard error: {e}")

@app.post("/scan")
async def scan_file(file: UploadFile = File(...), user: str = "unknown"):
    data = await file.read()
    filename = file.filename or "unknown"
    config = load_config()
    engines = [e for e in config.get("engines", []) if e.get("enabled", True)]
    tasks = [scan_with_engine(e, data, filename) for e in engines]
    results = await asyncio.gather(*tasks)
    await send_to_dashboard(filename, user, list(results))
    infected = any(r.get("infected") for r in results)
    threats = [r.get("threat") for r in results if r.get("threat")]
    return {"filename": filename, "infected": infected, "threats": threats, "results": list(results), "scanned_at": datetime.now().isoformat()}

@app.get("/engines")
async def get_engines():
    return load_config()

@app.post("/engines")
async def add_engine(engine: dict):
    config = load_config()
    import uuid
    engine["id"] = str(uuid.uuid4())[:8]
    config["engines"].append(engine)
    save_config(config)
    return {"status": "ok", "engine": engine}

@app.put("/engines/{engine_id}")
async def update_engine(engine_id: str, engine: dict):
    config = load_config()
    for i, e in enumerate(config["engines"]):
        if e["id"] == engine_id:
            engine["id"] = engine_id
            config["engines"][i] = engine
            save_config(config)
            return {"status": "ok", "engine": engine}
    raise HTTPException(status_code=404, detail="Engine not found")

@app.delete("/engines/{engine_id}")
async def delete_engine(engine_id: str):
    config = load_config()
    config["engines"] = [e for e in config["engines"] if e["id"] != engine_id]
    save_config(config)
    return {"status": "ok"}

@app.get("/health")
async def health():
    config = load_config()
    engines_status = []
    for e in config.get("engines", []):
        if e.get("type") == "clamav":
            try:
                cd = clamd.ClamdNetworkSocket(host=e.get("host","clamav"), port=int(e.get("port",3310)))
                cd.ping()
                engines_status.append({"name": e["name"], "status": "online"})
            except:
                engines_status.append({"name": e["name"], "status": "offline"})
        elif e.get("type") == "yara":
            rules_count = len([f for f in os.listdir(e.get("rules_path","/app/rules")) if f.endswith(('.yar','.yara'))])
            engines_status.append({"name": e["name"], "status": f"{rules_count} rules"})
        else:
            engines_status.append({"name": e["name"], "status": "enabled" if e.get("enabled") else "disabled"})
    return {"status": "ok", "engines": {e["name"]: e["status"] for e in engines_status}}

@app.get("/update/yara/list")
async def list_yara():
    rules = [f for f in os.listdir("/app/rules") if f.endswith(('.yar', '.yara'))]
    return {"rules": rules, "count": len(rules)}

@app.post("/update/yara")
async def update_yara(file: UploadFile = File(...)):
    if not file.filename.endswith(('.yar', '.yara')):
        raise HTTPException(status_code=400, detail="Only .yar or .yara files allowed")
    dest = os.path.join("/app/rules", file.filename)
    content = await file.read()
    with open(dest, 'wb') as f:
        f.write(content)
    try:
        yara.compile(filepath=dest)
        return {"status": "ok", "message": f"Rule {file.filename} updated successfully"}
    except Exception as e:
        os.remove(dest)
        raise HTTPException(status_code=400, detail=f"Invalid Yara rule: {str(e)}")

@app.delete("/update/yara/{filename}")
async def delete_yara(filename: str):
    filepath = os.path.join("/app/rules", filename)
    if os.path.exists(filepath):
        os.remove(filepath)
        return {"status": "ok", "message": f"Rule {filename} deleted"}
    raise HTTPException(status_code=404, detail="Rule not found")

@app.get("/")
async def root():
    return {"service": "Multi-AV Scanner", "version": "2.0.0"}

import zipfile
import tempfile

@app.post("/update/yara/zip")
async def update_yara_zip(file: UploadFile = File(...)):
    if not file.filename.endswith('.zip'):
        raise HTTPException(status_code=400, detail="Only .zip files allowed")
    
    content = await file.read()
    added = []
    rules_path = os.environ.get("YARA_RULES_PATH", "/app/rules")
    errors = []
    
    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = os.path.join(tmpdir, 'rules.zip')
        with open(zip_path, 'wb') as f:
            f.write(content)
        
        with zipfile.ZipFile(zip_path, 'r') as z:
            yar_files = [f for f in z.namelist() if f.endswith(('.yar', '.yara')) and not f.startswith('__')]
            
            for yar_file in yar_files:
                try:
                    filename = os.path.basename(yar_file)
                    if not filename:
                        continue
                    dest = os.path.join(rules_path, filename)
                    data = z.read(yar_file)
                    
                    # تست rule قبل از ذخیره
                    tmp_rule = os.path.join(tmpdir, filename)
                    with open(tmp_rule, 'wb') as f:
                        f.write(data)
                    
                    try:
                        yara.compile(filepath=tmp_rule)
                        with open(dest, 'wb') as f:
                            f.write(data)
                        added.append(filename)
                    except Exception as e:
                        errors.append({"file": filename, "error": str(e)})
                except Exception as e:
                    errors.append({"file": yar_file, "error": str(e)})
    
    return {
        "status": "ok",
        "added": len(added),
        "errors": len(errors),
        "added_files": added,
        "error_files": errors[:10]
    }
