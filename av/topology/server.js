const express = require('express');
const http = require('http');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3002;
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'PMO@123456';
const PROMETHEUS = process.env.PROMETHEUS_URL || 'http://nc_prometheus:9090';

app.use(express.json());
app.use(require('cors')());

function basicAuth(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Topology"');
        return res.status(401).send('Auth required');
    }
    const creds = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    if (creds[0] === DASHBOARD_USER && creds.slice(1).join(':') === DASHBOARD_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Topology"');
    return res.status(401).send('Invalid credentials');
}
app.use(basicAuth);

function dockerApi(path) {
    return new Promise((resolve) => {
        http.request({ socketPath: '/var/run/docker.sock', path, method: 'GET' }, (res) => {
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

function tcpCheck(host, port) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(2000);
        s.connect(port, host, () => { s.destroy(); resolve(true); });
        s.on('error', () => { s.destroy(); resolve(false); });
        s.on('timeout', () => { s.destroy(); resolve(false); });
    });
}

// گروه‌بندی container ها
const GROUPS = {
    'loadbalancer': { label: 'Load Balancer', color: '#1e3a5f', text: '#93c5fd', names: ['nc_nginx'] },
    'app':          { label: 'App Nodes',      color: '#14532d', text: '#86efac', prefix: 'nc_app' },
    'database':     { label: 'Database',       color: '#312e81', text: '#c4b5fd', names: ['nc_pg_primary','nc_pg_replica1','nc_pg_replica2','nc_pgbouncer'] },
    'cache':        { label: 'Cache / HA',     color: '#451a03', text: '#fdba74', names: ['nc_redis_master','nc_redis_replica1','nc_redis_replica2','nc_sentinel1','nc_sentinel2','nc_sentinel3'] },
    'antivirus':    { label: 'AntiVirus',      color: '#450a0a', text: '#fca5a5', names: ['clamav','av_scanner','av_dashboard','av_log_collector'] },
    'monitoring':   { label: 'Monitoring',     color: '#1e293b', text: '#94a3b8', names: ['nc_prometheus','nc_grafana','nc_cadvisor','nc_nginx_exporter','nc_pg_exporter','nc_redis_exporter'] },
    'other':        { label: 'Other',          color: '#1e293b', text: '#94a3b8', names: [] },
};

function getGroup(name) {
    for (const [gid, g] of Object.entries(GROUPS)) {
        if (g.names && g.names.includes(name)) return gid;
        if (g.prefix && name.startsWith(g.prefix)) return gid;
    }
    return 'other';
}

app.get('/api/topology', async (req, res) => {
    // گرفتن همه container ها از Docker
    const allContainers = await dockerApi('/containers/json?all=true');
    if (!allContainers) return res.status(500).json({ error: 'Docker API unavailable' });

    // گرفتن metric های Prometheus
    const [promUp, promContainers] = await Promise.all([
        promQuery('up'),
        promQuery('container_start_time_seconds'),
    ]);

    const promUpMap = {};
    promUp.forEach(r => {
        promUpMap[r.metric.job] = r.value[1] === '1';
    });

    const promContainerMap = {};
    promContainers.forEach(r => {
        if (r.metric.name) promContainerMap[r.metric.name] = parseFloat(r.value[1]) > 0;
    });

    const nodes = {};
    for (const c of allContainers) {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.slice(0, 12);
        const running = c.State === 'running';
        const healthy = c.Status && c.Status.includes('healthy') ? true :
                        c.Status && c.Status.includes('unhealthy') ? false : running;
        const promOk = promContainerMap.hasOwnProperty(name) ? promContainerMap[name] : null;
        const ok = promOk !== null ? (running && promOk) : healthy;

        nodes[name] = {
            ok,
            running,
            healthy,
            prom: promOk,
            label: name.replace(/^nc_/, '').replace(/_/g, ' '),
            status: c.Status,
            image: c.Image,
            group: getGroup(name),
        };
    }

    // TCP checks برای سرویس‌های مهم
    const tcpChecks = await Promise.all([
        tcpCheck('nc_nginx', 80).then(r => ({ key: 'nc_nginx', tcp: r })),
        tcpCheck('nc_pg_primary', 5432).then(r => ({ key: 'nc_pg_primary', tcp: r })),
        tcpCheck('nc_redis_master', 6379).then(r => ({ key: 'nc_redis_master', tcp: r })),
        tcpCheck('clamav', 3310).then(r => ({ key: 'clamav', tcp: r })),
        tcpCheck('av_scanner', 3311).then(r => ({ key: 'av_scanner', tcp: r })),
    ]);
    tcpChecks.forEach(({ key, tcp }) => {
        if (nodes[key]) nodes[key].tcp = tcp;
    });

    const total = Object.keys(nodes).length;
    const online = Object.values(nodes).filter(n => n.ok).length;

    res.json({
        timestamp: new Date().toISOString(),
        summary: { total, online, offline: total - online },
        groups: GROUPS,
        nodes,
        promJobs: promUpMap,
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static('public'));
app.listen(PORT, () => console.log('Topology API on port ' + PORT));
