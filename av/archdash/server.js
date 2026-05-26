const express = require('express');
const diagEngine = require('./diagnosis-engine');
const remEngine = require('./remediation-engine');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3003;
const PROMETHEUS = process.env.PROMETHEUS_URL || 'http://nc_prometheus:9090';
const DESC_FILE = path.join(__dirname, 'descriptions.json');

app.use(express.json());
app.use(require('cors')());
app.use(express.static('public'));

function dockerApi(p) {
  return new Promise((resolve) => {
    http.request({ socketPath: '/var/run/docker.sock', path: p, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).end();
  });
}

function promQuery(query) {
  return new Promise((resolve) => {
    const url = new URL(PROMETHEUS + '/api/v1/query');
    url.searchParams.set('query', query);
    http.get(url.toString(), (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.data && json.data.result ? json.data.result : []);
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// گروه‌بندی container ها
const GROUPS = {
  loadbalancer: { label: 'Load Balancer', names: ['nc_nginx'] },
  app:          { label: 'App Nodes',     prefix: 'nc_app' },
  database:     { label: 'Database',      names: ['nc_pg_primary','nc_pg_replica1','nc_pg_replica2','nc_pgbouncer'] },
  cache:        { label: 'Cache / Redis', names: ['nc_redis_master','nc_redis_replica1','nc_redis_replica2','nc_sentinel1','nc_sentinel2','nc_sentinel3'] },
  antivirus:    { label: 'AntiVirus',     names: ['clamav','av_scanner','av_dashboard','av_log_collector'] },
  monitoring:   { label: 'Monitoring',    names: ['nc_prometheus','nc_grafana','nc_cadvisor','nc_nginx_exporter','nc_pg_exporter','nc_redis_exporter'] },
  other:        { label: 'سایر',          names: ['av_topology','nc_cron'] },
};

function getGroup(name) {
  for (const [gid, g] of Object.entries(GROUPS)) {
    if (g.names && g.names.includes(name)) return gid;
    if (g.prefix && name.startsWith(g.prefix)) return gid;
  }
  return 'other';
}

// API: وضعیت live container ها
app.get('/api/status', async (req, res) => {
  const containers = await dockerApi('/containers/json?all=true');
  if (!containers) return res.status(500).json({ error: 'Docker unavailable' });

  const [promContainers] = await Promise.all([
    promQuery('container_start_time_seconds'),
  ]);

  const promMap = {};
  promContainers.forEach(r => {
    if (r.metric.name) promMap[r.metric.name] = parseFloat(r.value[1]) > 0;
  });

  const nodes = {};
  for (const c of containers) {
    const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.slice(0,12);
    const running = c.State === 'running';
    const healthy = c.Status && c.Status.includes('(healthy)') ? true :
                    c.Status && c.Status.includes('(unhealthy)') ? false : running;
    const promOk = promMap.hasOwnProperty(name) ? promMap[name] : null;
    const ok = promOk !== null ? (running && promOk) : healthy;

    nodes[name] = {
      ok,
      running,
      healthy,
      status: c.Status,
      image: c.Image,
      group: getGroup(name),
      label: name.replace(/^nc_/, '').replace(/_/g, ' '),
    };
  }

  const total = Object.keys(nodes).length;
  const online = Object.values(nodes).filter(n => n.ok).length;

  res.json({
    timestamp: new Date().toISOString(),
    summary: { total, online, offline: total - online },
    nodes,
    groups: GROUPS,
  });
});

// API: خواندن توضیحات
app.get('/api/descriptions', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DESC_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.json({});
  }
});

// API: ذخیره توضیح یک container
app.put('/api/descriptions/:name', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DESC_FILE, 'utf8'));
    data[req.params.name] = req.body;
    fs.writeFileSync(DESC_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/remediate', async (req, res) => {
  const { container, diagnosis } = req.body;
  if (!container) return res.status(400).json({ error: 'no container' });
  try {
    const result = await remEngine.remediate(container, diagnosis || []);
    res.json({ container, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message, steps: [] });
  }
});

app.get('/api/remediate-stream/:container', async (req, res) => {
  const container = req.params.container;
  const diagnosis = req.query.diag ? JSON.parse(decodeURIComponent(req.query.diag)) : [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write('data: ' + JSON.stringify({ type, ...data }) + '\n\n');
  };

  try {
    const origRemediate = remEngine.remediate;
    const steps = [];
    const result = await remEngine.remediateStream(container, diagnosis, (step) => {
      steps.push(step);
      send('step', { msg: step.msg, time: step.time });
    });
    send('done', { success: result.success, manual: result.manual || false, warning: result.warning || null });
  } catch(e) {
    send('error', { msg: e.message });
  }
  res.end();
});

app.post('/api/diagnose', async (req, res) => {
  const { container } = req.body;
  if (!container) return res.status(400).json({ error: 'no container' });
  try {
    const results = await diagEngine.diagnose(container);
    res.json({ container, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => console.log('ArchDash on port ' + PORT));

const { exec } = require('child_process');
const fs2 = require('fs');
const DIAG_FILE = path.join(__dirname, 'diagnostics.json');

app.get('/api/diagnostics', (req, res) => {
  try {
    const data = JSON.parse(fs2.readFileSync(DIAG_FILE, 'utf8'));
    res.json(data);
  } catch { res.json({}); }
});

// تبدیل دستور docker به API call مستقیم یا nsenter
function resolveCmd(cmd) {
  // docker logs
  var m = cmd.match(/^docker logs (\S+)(.*)$/);
  if (m) return { type:'dockerapi', path:'/containers/'+m[1]+'/logs?stdout=1&stderr=1&tail=50' };
  // docker inspect
  m = cmd.match(/^docker inspect (\S+)/);
  if (m) return { type:'dockerapi', path:'/containers/'+m[1]+'/json' };
  // docker restart
  m = cmd.match(/^docker restart (\S+)$/);
  if (m) return { type:'dockerrestart', name:m[1] };
  // docker exec
  m = cmd.match(/^docker exec (\S+) (.+)$/);
  if (m) return { type:'dockerexec', container: m[1], command: m[2] };
  // curl localhost
  if (cmd.startsWith('curl')) return { type:'shell', cmd: cmd };
  // ls, cat, ss
  if (cmd.match(/^(ls |cat |ss |df |grep )/)) return { type:'shell', cmd: cmd };
  return null;
}

function dockerApiRaw(p, method) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path: p, method: method||'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 500, body: e.message }));
    req.end();
  });
}

app.post('/api/exec', async (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'no cmd' });

  const resolved = resolveCmd(cmd);
  if (!resolved) return res.status(403).json({ error: 'دستور مجاز نیست: ' + cmd });

  try {
    if (resolved.type === 'dockerapi') {
      const r = await dockerApiRaw(resolved.path);
      let out = r.body;
      try { out = JSON.stringify(JSON.parse(r.body), null, 2); } catch {}
      return res.json({ output: out });
    }

    if (resolved.type === 'dockerexec') {
      // create exec instance
      const createBody = JSON.stringify({
        AttachStdout: true, AttachStderr: true,
        Cmd: ['/bin/sh', '-c', resolved.command]
      });
      const createRes = await new Promise((resolve) => {
        const req = http.request({
          socketPath: '/var/run/docker.sock',
          path: '/containers/'+resolved.container+'/exec',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(createBody) }
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', e => resolve({ status:500, body: e.message }));
        req.write(createBody);
        req.end();
      });
      if (createRes.status !== 201) return res.json({ output: 'exec create error: ' + createRes.body });
      const execId = JSON.parse(createRes.body).Id;
      // start exec
      const startBody = JSON.stringify({ Detach: false, Tty: false });
      const startRes = await new Promise((resolve) => {
        const req = http.request({
          socketPath: '/var/run/docker.sock',
          path: '/exec/'+execId+'/start',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(startBody) }
        }, (res) => {
          let data = Buffer.alloc(0);
          res.on('data', c => { data = Buffer.concat([data, c]); });
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', e => resolve({ status:500, body: Buffer.from(e.message) }));
        req.write(startBody);
        req.end();
      });
      // strip docker stream header (8 bytes per chunk)
      let output = '';
      let buf = startRes.body;
      let i = 0;
      while (i + 8 <= buf.length) {
        const size = buf.readUInt32BE(i + 4);
        if (i + 8 + size <= buf.length) {
          output += buf.slice(i + 8, i + 8 + size).toString('utf8');
        }
        i += 8 + size;
      }
      if (!output) output = buf.toString('utf8');
      return res.json({ output: output || '(بدون خروجی)' });
    }

    if (resolved.type === 'dockerrestart') {
      const r = await dockerApiRaw('/containers/'+resolved.name+'/restart', 'POST');
      return res.json({ output: r.status === 204 ? 'container '+resolved.name+' restarted ✓' : 'error: '+r.body });
    }

    if (resolved.type === 'shell') {
      exec(resolved.cmd, { timeout: 15000, shell: '/bin/sh' }, (err, stdout, stderr) => {
        res.json({ output: stdout || stderr || (err ? err.message : 'بدون خروجی') });
      });
      return;
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
