const express = require('express');
const net = require('net');
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAMD_HOST = process.env.CLAMD_HOST || 'clamav';
const CLAMD_PORT = parseInt(process.env.CLAMD_PORT) || 3310;
const SCANNER_URL = process.env.SCANNER_URL || 'http://av_scanner:8000';
const QUARANTINE_PATH = process.env.QUARANTINE_PATH || '/quarantine';
const CLAMAV_DB_PATH = process.env.CLAMAV_DB_PATH || '/clamav_db';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'PMO@123456';
const DATA_FILE = '/data/scan_history.json';

app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// بارگذاری تاریخچه از فایل
let scanHistory = [];
let stats = { totalScanned: 0, totalClean: 0, totalInfected: 0, totalQuarantined: 0 };

async function loadHistory() {
    try {
        await fs.ensureDir('/data');
        if (await fs.pathExists(DATA_FILE)) {
            const data = await fs.readJson(DATA_FILE);
            scanHistory = data.history || [];
            stats = data.stats || stats;
            console.log(`Loaded ${scanHistory.length} records from disk`);
        }
    } catch (e) { console.error('Load history error:', e.message); }
}

async function saveHistory() {
    try {
        await fs.ensureDir('/data');
        await fs.writeJson(DATA_FILE, { history: scanHistory.slice(0, 5000), stats });
    } catch (e) { console.error('Save history error:', e.message); }
}

loadHistory();

function basicAuth(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="AV Dashboard"');
        return res.status(401).send('Authentication required');
    }
    const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [user, pass] = credentials.split(':');
    if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="AV Dashboard"');
    return res.status(401).send('Invalid credentials');
}
app.get("/logout", function(req, res) { res.set("WWW-Authenticate", "Basic realm=\"AV Dashboard\""); res.status(401).send("<h2>Logged out. <a href=\"/\">Login again</a></h2>"); });
app.use(function(req, res, next) { if (req.path === "/api/scan-result") return next(); basicAuth(req, res, next); });

function checkClamd() {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.setTimeout(5000);
        client.connect(CLAMD_PORT, CLAMD_HOST, () => { client.write('PING\n'); });
        client.on('data', (data) => { client.destroy(); resolve({ online: data.toString().includes('PONG') }); });
        client.on('error', () => { client.destroy(); resolve({ online: false }); });
        client.on('timeout', () => { client.destroy(); resolve({ online: false }); });
    });
}

function getClamdVersion() {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.setTimeout(5000);
        client.connect(CLAMD_PORT, CLAMD_HOST, () => { client.write('VERSION\n'); });
        client.on('data', (data) => { client.destroy(); resolve(data.toString().trim()); });
        client.on('error', () => { client.destroy(); resolve('unknown'); });
        client.on('timeout', () => { client.destroy(); resolve('unknown'); });
    });
}

function getScannerHealth() {
    return new Promise((resolve) => {
        const url = new URL(SCANNER_URL + '/health');
        const req = http.get({ hostname: url.hostname, port: url.port || 80, path: url.pathname, timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function scannerRequest(method, urlPath, body, contentType) {
    return new Promise((resolve, reject) => {
        const url = new URL(SCANNER_URL + urlPath);
        const options = { hostname: url.hostname, port: url.port || 80, path: url.pathname, method, headers: {} };
        if (contentType) options.headers['Content-Type'] = contentType;
        if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, data }); } });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

app.get('/api/status', async (req, res) => {
    const scannerHealth = await getScannerHealth();
    
    // گرفتن لیست engines از scanner
    const enginesConfig = await new Promise((resolve) => {
        const url = new URL(SCANNER_URL + '/engines');
        http.get({hostname: url.hostname, port: url.port||80, path: url.pathname, timeout: 5000}, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });

    const engines = [];
    if (enginesConfig && enginesConfig.engines) {
        for (const e of enginesConfig.engines) {
            if (!e.enabled) continue;
            if (e.type === 'clamav') {
                const ping = await new Promise((resolve) => {
                    const client = new net.Socket();
                    client.setTimeout(3000);
                    client.connect(e.port||3310, e.host||'clamav', () => { client.write('PING\n'); });
                    client.on('data', (d) => { client.destroy(); resolve(d.toString().includes('PONG')); });
                    client.on('error', () => { client.destroy(); resolve(false); });
                    client.on('timeout', () => { client.destroy(); resolve(false); });
                });
                const version = ping ? await new Promise((resolve) => {
                    const client = new net.Socket();
                    client.setTimeout(3000);
                    client.connect(e.port||3310, e.host||'clamav', () => { client.write('VERSION\n'); });
                    client.on('data', (d) => { client.destroy(); resolve(d.toString().trim()); });
                    client.on('error', () => { client.destroy(); resolve('unknown'); });
                    client.on('timeout', () => { client.destroy(); resolve('unknown'); });
                }) : 'offline';
                engines.push({name: e.name, status: ping?'online':'offline', version, host: e.host, port: e.port});
            } else if (e.type === 'yara') {
                const yaraStatus = scannerHealth ? (scannerHealth.engines?.Yara || scannerHealth.engines?.yara || 'unknown') : 'offline';
                engines.push({name: e.name, status: yaraStatus.includes('rules')?'online':'offline', version: yaraStatus, host: 'av_scanner', port: 8000});
            } else if (e.type === 'virustotal') {
                engines.push({name: e.name, status: e.api_key?'online':'no_api_key', version: 'API', host: 'virustotal.com', port: 443});
            } else if (e.type === 'rest_api') {
                engines.push({name: e.name, status: 'enabled', version: e.url||'REST API', host: e.url||'', port: 0});
            }
        }
    }

    res.json({ status: 'ok', timestamp: new Date(), engines, stats });
});

app.get('/api/scans', (req, res) => {
    let results = [...scanHistory];
    if (req.query.filter === 'infected') results = results.filter(s => s.infected);
    if (req.query.filter === 'clean') results = results.filter(s => !s.infected);
    if (req.query.user) results = results.filter(s => s.user === req.query.user);
    if (req.query.from) results = results.filter(s => new Date(s.scannedAt) >= new Date(req.query.from));
    if (req.query.to) results = results.filter(s => new Date(s.scannedAt) <= new Date(req.query.to));
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const total = results.length;
    const paged = results.slice((page-1)*limit, page*limit);
    res.json({ total, page, limit, pages: Math.ceil(total/limit), scans: paged });
});

app.get('/api/users', (req, res) => {
    const users = [...new Set(scanHistory.map(s => s.user).filter(Boolean))];
    res.json({ users });
});

app.get('/api/report', (req, res) => {
    let results = [...scanHistory];
    if (req.query.user) results = results.filter(s => s.user === req.query.user);
    if (req.query.from) results = results.filter(s => new Date(s.scannedAt) >= new Date(req.query.from));
    if (req.query.to) results = results.filter(s => new Date(s.scannedAt) <= new Date(req.query.to));

    const byUser = {};
    const byDate = {};
    results.forEach(s => {
        if (!byUser[s.user]) byUser[s.user] = { total: 0, clean: 0, infected: 0 };
        byUser[s.user].total++;
        s.infected ? byUser[s.user].infected++ : byUser[s.user].clean++;
        const date = new Date(s.scannedAt).toISOString().split('T')[0];
        if (!byDate[date]) byDate[date] = { total: 0, clean: 0, infected: 0 };
        byDate[date].total++;
        s.infected ? byDate[date].infected++ : byDate[date].clean++;
    });

    res.json({ total: results.length, clean: results.filter(s=>!s.infected).length, infected: results.filter(s=>s.infected).length, byUser, byDate });
});

app.get('/api/quarantine', async (req, res) => {
    try {
        const files = await fs.readdir(QUARANTINE_PATH).catch(() => []);
        const details = await Promise.all(files.map(async f => {
            const stat = await fs.stat(path.join(QUARANTINE_PATH, f)).catch(() => null);
            return stat ? { name: f, size: stat.size, quarantinedAt: stat.mtime } : null;
        }));
        res.json({ total: details.filter(Boolean).length, files: details.filter(Boolean) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/quarantine/:filename', async (req, res) => {
    await fs.remove(path.join(QUARANTINE_PATH, req.params.filename));
    res.json({ success: true });
});

app.post('/api/scan-result', async (req, res) => {
    const result = { id: Date.now(), scannedAt: new Date(), ...req.body };
    if (result.user === 'nextcloud') return res.json({ success: true });
    scanHistory.unshift(result);
    stats.totalScanned++;
    if (result.infected) { stats.totalInfected++; if (result.quarantined) stats.totalQuarantined++; }
    else stats.totalClean++;
    if (scanHistory.length > 5000) scanHistory = scanHistory.slice(0, 5000);
    await saveHistory();
    res.json({ success: true });
});

app.post('/api/update/clamav', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = req.file.originalname;
    if (!filename.endsWith('.cvd') && !filename.endsWith('.cld')) return res.status(400).json({ error: 'Only .cvd or .cld files allowed' });
    try {
        await fs.writeFile(path.join(CLAMAV_DB_PATH, filename), req.file.buffer);
        res.json({ status: 'ok', message: `ClamAV signature ${filename} updated. Restart ClamAV to apply.` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update/yara', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = req.file.originalname;
    if (!filename.endsWith('.yar') && !filename.endsWith('.yara')) return res.status(400).json({ error: 'Only .yar or .yara files allowed' });
    try {
        const boundary = '----FormBoundary' + Date.now();
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
            req.file.buffer,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        const url = new URL(SCANNER_URL + '/update/yara');
        const result = await new Promise((resolve, reject) => {
            const request = http.request({
                hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
            }, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(data) }));
            });
            request.on('error', reject);
            request.write(body);
            request.end();
        });
        res.json(result.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/engines', function(req, res) {
  var url = new URL(SCANNER_URL + '/engines');
  http.get({hostname: url.hostname, port: url.port||80, path: url.pathname}, function(r) {
    var d=''; r.on('data',function(c){d+=c;}); r.on('end',function(){res.json(JSON.parse(d));});
  }).on('error', function(e){res.status(500).json({error:e.message});});
});

app.post('/api/engines', function(req, res) {
  var body = JSON.stringify(req.body);
  var url = new URL(SCANNER_URL + '/engines');
  var r = http.request({hostname:url.hostname,port:url.port||80,path:url.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(resp){
    var d=''; resp.on('data',function(c){d+=c;}); resp.on('end',function(){res.status(resp.statusCode).json(JSON.parse(d));});
  }); r.on('error',function(e){res.status(500).json({error:e.message});}); r.write(body); r.end();
});

app.put('/api/engines/:id', function(req, res) {
  var body = JSON.stringify(req.body);
  var url = new URL(SCANNER_URL + '/engines/' + req.params.id);
  var r = http.request({hostname:url.hostname,port:url.port||80,path:url.pathname,method:'PUT',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(resp){
    var d=''; resp.on('data',function(c){d+=c;}); resp.on('end',function(){res.status(resp.statusCode).json(JSON.parse(d));});
  }); r.on('error',function(e){res.status(500).json({error:e.message});}); r.write(body); r.end();
});

app.delete('/api/engines/:id', function(req, res) {
  var url = new URL(SCANNER_URL + '/engines/' + req.params.id);
  var r = http.request({hostname:url.hostname,port:url.port||80,path:url.pathname,method:'DELETE'},function(resp){
    var d=''; resp.on('data',function(c){d+=c;}); resp.on('end',function(){res.status(resp.statusCode).json(JSON.parse(d));});
  }); r.on('error',function(e){res.status(500).json({error:e.message});}); r.end();
});

app.get('/api/update/yara/list', async (req, res) => {
    try { const result = await scannerRequest('GET', '/update/yara/list'); res.json(result.data); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/update/yara/:filename', async (req, res) => {
    try { const result = await scannerRequest('DELETE', `/update/yara/${req.params.filename}`); res.json(result.data); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log('AV Dashboard on port ' + PORT));
app.post('/api/update/yara/zip', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.endsWith('.zip')) return res.status(400).json({ error: 'Only .zip files allowed' });
  try {
    const boundary = '----FormBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + req.file.originalname + '"\r\nContent-Type: application/zip\r\n\r\n'),
      req.file.buffer,
      Buffer.from('\r\n--' + boundary + '--\r\n')
    ]);
    const url = new URL(SCANNER_URL + '/update/yara/zip');
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: url.hostname, port: url.port||80, path: url.pathname, method: 'POST',
        headers: {'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length}
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve({status: response.statusCode, data: JSON.parse(data)}));
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
