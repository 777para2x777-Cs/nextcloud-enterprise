"""
ClamAV-compatible TCP proxy
پورت 3311 را listen می‌کنه و مثل clamd رفتار می‌کنه
ولی داخلاً فایل را به همه AV ها می‌فرسته
"""
import asyncio
import io
import clamd
import yara
import os
import logging
import aiohttp

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CLAMD_HOST = os.environ.get("CLAMD_HOST", "clamav")
CLAMD_PORT = int(os.environ.get("CLAMD_PORT", "3310"))
YARA_RULES_PATH = os.environ.get("YARA_RULES_PATH", "/app/rules")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "3311"))
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://av_dashboard:3000")
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "PMO@123456")

def scan_clamav(data: bytes) -> dict:
    try:
        cd = clamd.ClamdNetworkSocket(host=CLAMD_HOST, port=CLAMD_PORT)
        result = cd.instream(io.BytesIO(data))
        status = result.get('stream', ('OK', None))
        infected = status[0] == 'FOUND'
        return {"engine": "ClamAV", "infected": infected, "threat": status[1] if infected else None}
    except Exception as e:
        logger.error(f"ClamAV error: {e}")
        return {"engine": "ClamAV", "infected": False, "threat": None}

def scan_yara(data: bytes) -> dict:
    try:
        rules_files = [f for f in os.listdir(YARA_RULES_PATH) if f.endswith('.yar') or f.endswith('.yara')]
        matches = []
        for rule_file in rules_files:
            try:
                rules = yara.compile(filepath=os.path.join(YARA_RULES_PATH, rule_file))
                m = rules.match(data=data)
                if m:
                    matches.extend([str(match) for match in m])
            except Exception as e:
                logger.error(f"Yara rule error: {e}")
        infected = len(matches) > 0
        return {"engine": "Yara", "infected": infected, "threat": ", ".join(matches) if infected else None}
    except Exception as e:
        return {"engine": "Yara", "infected": False, "threat": None}

async def send_to_dashboard(results: list):
    infected = any(r.get("infected") for r in results)
    threats = [r.get("threat") for r in results if r.get("threat")]
    try:
        async with aiohttp.ClientSession() as session:
            await session.post(
                f"{DASHBOARD_URL}/api/scan-result",
                auth=aiohttp.BasicAuth(DASHBOARD_USER, DASHBOARD_PASS),
                json={
                    "filename": "upload",
                    "infected": infected,
                    "threat": ", ".join(threats) if threats else None,
                    "engine": " + ".join([r["engine"] for r in results]),
                    "user": "nextcloud",
                    "quarantined": False
                }
            )
    except Exception as e:
        logger.error(f"Dashboard error: {e}")

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    addr = writer.get_extra_info('peername')
    logger.info(f"Connection from {addr}")
    
    try:
        # خواندن command
        command = await reader.read(10)
        
        if command.startswith(b'PING'):
            writer.write(b'PONG\n')
            await writer.drain()
            writer.close()
            return
            
        if command.startswith(b'VERSION'):
            writer.write(b'ClamAV 1.4.4/MultiAV-Proxy\n')
            await writer.drain()
            writer.close()
            return
        
        if command.startswith(b'nINSTREAM') or command.startswith(b'INSTREAM'):
            # خواندن داده stream
            data = bytearray()
            while True:
                # خواندن 4 بایت length
                length_bytes = await reader.readexactly(4)
                length = int.from_bytes(length_bytes, byteorder='big')
                
                if length == 0:
                    break
                
                chunk = await reader.readexactly(length)
                data.extend(chunk)
            
            data = bytes(data)
            logger.info(f"Received {len(data)} bytes for scanning")
            
            # اسکن موازی
            loop = asyncio.get_event_loop()
            clamav_result = await loop.run_in_executor(None, scan_clamav, data)
            yara_result = await loop.run_in_executor(None, scan_yara, data)
            
            results = [clamav_result, yara_result]
            
            # ارسال به dashboard
            await send_to_dashboard(results)
            
            # تعیین نتیجه نهایی
            infected = any(r.get("infected") for r in results)
            threats = [r.get("threat") for r in results if r.get("threat")]
            
            if infected:
                threat_name = threats[0] if threats else "Unknown"
                response = f'stream: {threat_name} FOUND\n'
                logger.info(f"INFECTED: {threat_name}")
            else:
                response = 'stream: OK\n'
                logger.info("CLEAN")
            
            writer.write(response.encode())
            await writer.drain()
    
    except asyncio.IncompleteReadError:
        pass
    except Exception as e:
        logger.error(f"Error handling client: {e}")
        try:
            writer.write(b'stream: OK\n')
            await writer.drain()
        except:
            pass
    finally:
        try:
            writer.close()
        except:
            pass

async def main():
    server = await asyncio.start_server(handle_client, '0.0.0.0', PROXY_PORT)
    logger.info(f"ClamAV-compatible proxy listening on port {PROXY_PORT}")
    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    asyncio.run(main())
