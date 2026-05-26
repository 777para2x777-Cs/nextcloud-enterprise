const http = require('http');
const { exec } = require('child_process');

// ═══════════════════════════════════════
// Docker API helpers
// ═══════════════════════════════════════
function dockerApiRaw(p, method) {
  return new Promise((resolve) => {
    http.request({ socketPath: '/var/run/docker.sock', path: p, method: method||'GET' }, (res) => {
      let data = Buffer.alloc(0);
      res.on('data', c => { data = Buffer.concat([data, c]); });
      res.on('end', () => resolve({ status: res.statusCode, body: data.toString('utf8') }));
    }).on('error', e => resolve({ status:500, body: e.message })).end();
  });
}

function dockerExec(container, command) {
  return new Promise(async (resolve) => {
    try {
      const createBody = JSON.stringify({
        AttachStdout: true, AttachStderr: true,
        Cmd: ['/bin/sh', '-c', command]
      });
      const createRes = await new Promise((res) => {
        const req = http.request({
          socketPath: '/var/run/docker.sock',
          path: '/containers/'+container+'/exec',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(createBody) }
        }, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => res({ status: r.statusCode, body: d }));
        });
        req.on('error', e => res({ status:500, body: e.message }));
        req.write(createBody);
        req.end();
      });
      if (createRes.status !== 201) return resolve({ ok: false, output: 'exec error: ' + createRes.body });
      const execId = JSON.parse(createRes.body).Id;
      const startBody = JSON.stringify({ Detach: false, Tty: false });
      const startRes = await new Promise((res) => {
        const req = http.request({
          socketPath: '/var/run/docker.sock',
          path: '/exec/'+execId+'/start',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(startBody) }
        }, (r) => {
          let d = Buffer.alloc(0);
          r.on('data', c => { d = Buffer.concat([d, c]); });
          r.on('end', () => res({ status: r.statusCode, body: d }));
        });
        req.on('error', e => res({ status:500, body: Buffer.from(e.message) }));
        req.write(startBody);
        req.end();
      });
      let output = '';
      let buf = startRes.body;
      let i = 0;
      while (i + 8 <= buf.length) {
        const size = buf.readUInt32BE(i + 4);
        if (i + 8 + size <= buf.length) output += buf.slice(i + 8, i + 8 + size).toString('utf8');
        i += 8 + size;
      }
      if (!output) output = buf.toString('utf8');
      resolve({ ok: true, output: output.trim() });
    } catch(e) {
      resolve({ ok: false, output: e.message });
    }
  });
}

function shellExec(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || stderr || '').trim() });
    });
  });
}

function getContainerInspect(name) {
  return dockerApiRaw('/containers/'+name+'/json').then(r => {
    try { return JSON.parse(r.body); } catch { return null; }
  });
}

function getContainerLogs(name, tail=30) {
  return dockerApiRaw('/containers/'+name+'/logs?stdout=1&stderr=1&tail='+tail).then(r => {
    return r.body.replace(/[\x00-\x08\x0e-\x1f]/g, '');
  });
}

// ═══════════════════════════════════════
// Parser helpers
// ═══════════════════════════════════════
function parseExitCode(inspect) {
  return inspect && inspect.State ? inspect.State.ExitCode : null;
}

function parseOOMKilled(inspect) {
  return inspect && inspect.State && inspect.State.OOMKilled;
}

function parseRestartCount(inspect) {
  return inspect && inspect.RestartCount ? inspect.RestartCount : 0;
}

function logContains(logs, ...patterns) {
  return patterns.some(p => logs.toLowerCase().includes(p.toLowerCase()));
}

function severity(level, title, reason, suggestion, commands=[]) {
  return { level, title, reason, suggestion, commands };
}

// ═══════════════════════════════════════
// تشخیص‌دهنده‌های هر گروه سرویس
// ═══════════════════════════════════════

async function diagnoseApp(name) {
  const results = [];
  const inspect = await getContainerInspect(name);
  const logs = await getContainerLogs(name, 50);

  if (!inspect) {
    return [severity('critical', 'Container پیدا نشد', 'Docker نمی‌تواند container را پیدا کند', 'docker-compose را بررسی کنید', ['docker compose ps'])];
  }

  const exitCode = parseExitCode(inspect);
  const oomKilled = parseOOMKilled(inspect);
  const restartCount = parseRestartCount(inspect);

  if (oomKilled) {
    results.push(severity('critical', 'OOM Killer — حافظه تمام شد',
      'سیستم به دلیل کمبود RAM این container را kill کرده',
      'محدودیت memory را در docker-compose بررسی کنید یا RAM سرور را افزایش دهید',
      ['free -h', 'docker stats --no-stream']));
  }

  if (restartCount > 5) {
    results.push(severity('warning', 'restart loop — '+restartCount+' بار ریستارت',
      'Container مکرراً crash می‌کند',
      'لاگ‌ها را بررسی کنید تا علت اصلی crash پیدا شود',
      ['docker logs '+name+' --tail 100']));
  }

  if (logContains(logs, 'could not connect to server', 'connection refused', 'pgbouncer')) {
    results.push(severity('critical', 'اتصال DB قطع است',
      'App نمی‌تواند به PgBouncer یا PostgreSQL متصل شود',
      'وضعیت nc_pgbouncer و nc_pg_primary را بررسی کنید',
      ['docker inspect nc_pgbouncer --format={{.State.Status}}',
       'docker inspect nc_pg_primary --format={{.State.Status}}']));
  }

  if (logContains(logs, 'redis', 'NOAUTH', 'connection to redis failed')) {
    results.push(severity('critical', 'اتصال Redis قطع است',
      'App نمی‌تواند به Redis متصل شود',
      'وضعیت nc_redis_master را بررسی کنید',
      ['docker inspect nc_redis_master --format={{.State.Status}}',
       'docker exec nc_redis_master redis-cli -a PMO@123456 ping']));
  }

  if (logContains(logs, 'permission denied', 'cannot write')) {
    results.push(severity('warning', 'مشکل دسترسی فایل',
      'خطای permission در volume یا data directory',
      'ownership فایل‌های Nextcloud را بررسی کنید',
      ['docker exec '+name+' ls -la /var/www/html/data']));
  }

  if (logContains(logs, 'fatal error', 'php fatal', 'segfault')) {
    results.push(severity('critical', 'PHP Fatal Error',
      'خطای بحرانی PHP رخ داده',
      'لاگ کامل را بررسی کنید',
      ['docker logs '+name+' --tail 100']));
  }

  if (exitCode !== null && exitCode !== 0 && !oomKilled) {
    results.push(severity('warning', 'exit code: '+exitCode,
      'Container با کد خطا متوقف شده',
      'لاگ‌های آخر را بررسی کنید',
      ['docker logs '+name+' --tail 50']));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد',
      'Container متوقف است اما لاگ‌ها علت واضحی نشان نمی‌دهند',
      'لاگ کامل‌تر را بررسی کنید',
      ['docker logs '+name+' --tail 100', 'docker inspect '+name]));
  }

  return results;
}

async function diagnosePostgres(name) {
  const results = [];
  const inspect = await getContainerInspect(name);
  const logs = await getContainerLogs(name, 50);

  if (!inspect) return [severity('critical', 'Container پیدا نشد', '', 'docker compose را بررسی کنید', [])];

  const oomKilled = parseOOMKilled(inspect);
  if (oomKilled) {
    results.push(severity('critical', 'OOM Killed',
      'PostgreSQL به دلیل کمبود RAM kill شده',
      'shared_buffers و work_mem را کاهش دهید',
      ['free -h']));
  }

  if (logContains(logs, 'no space left on device', 'disk full')) {
    results.push(severity('critical', 'دیسک پر است',
      'PostgreSQL نمی‌تواند بنویسد — دیسک پر شده',
      'فضای دیسک را آزاد کنید',
      ['df -h', 'du -sh /data/docker/volumes/']));
  }

  if (logContains(logs, 'max_connections', 'too many connections', 'remaining connection slots')) {
    results.push(severity('critical', 'حداکثر connections پر است',
      'PostgreSQL دیگر connection جدید نمی‌پذیرد',
      'PgBouncer pooling را بررسی کنید یا max_connections را افزایش دهید',
      ['docker exec nc_pg_primary psql -U nextcloud -d nextcloud -c "SELECT count(*) FROM pg_stat_activity;"']));
  }

  if (logContains(logs, 'invalid page', 'corrupted', 'checksum')) {
    results.push(severity('critical', 'دیتابیس آسیب دیده',
      'خطای checksum یا corruption در data files',
      'بلافاصله از backup استفاده کنید',
      ['docker logs '+name+' --tail 100']));
  }

  if (logContains(logs, 'wal', 'replication', 'recovery')) {
    results.push(severity('warning', 'مشکل WAL / Replication',
      'خطای مربوط به WAL یا replication در لاگ‌ها',
      'وضعیت replication را بررسی کنید',
      ['docker exec nc_pg_primary psql -U nextcloud -d nextcloud -c "SELECT * FROM pg_stat_replication;"']));
  }

  if (logContains(logs, 'authentication failed', 'password authentication')) {
    results.push(severity('warning', 'خطای احراز هویت',
      'اتصال با credentials اشتباه رد شده',
      'POSTGRES_PASSWORD را در .env بررسی کنید',
      []));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد',
      'لاگ‌ها علت واضحی ندارند',
      'لاگ کامل را بررسی کنید',
      ['docker logs '+name+' --tail 100']));
  }

  return results;
}

async function diagnoseRedis(name) {
  const results = [];
  const inspect = await getContainerInspect(name);
  const logs = await getContainerLogs(name, 50);

  if (!inspect) return [severity('critical', 'Container پیدا نشد', '', '', [])];

  if (logContains(logs, 'NOAUTH', 'invalid password', 'ERR AUTH')) {
    results.push(severity('critical', 'خطای احراز هویت Redis',
      'پسورد Redis اشتباه است',
      'REDIS_PASSWORD در .env را با sentinel.conf مقایسه کنید',
      ['grep REDIS_PASSWORD /root/nextcloud/.env',
       'grep auth-pass /root/nextcloud/conf/redis/sentinel.conf']));
  }

  if (logContains(logs, 'out of memory', 'maxmemory', 'OOM')) {
    results.push(severity('critical', 'حافظه Redis پر است',
      'Redis به حداکثر memory رسیده',
      'maxmemory-policy را بررسی کنید یا cache را flush کنید',
      ['docker exec nc_redis_master redis-cli -a PMO@123456 info memory']));
  }

  if (logContains(logs, 'connection refused', 'can\'t connect to master')) {
    results.push(severity('critical', 'اتصال به master قطع است',
      'Redis replica نمی‌تواند به master متصل شود',
      'وضعیت nc_redis_master را بررسی کنید',
      ['docker inspect nc_redis_master --format={{.State.Status}}',
       'docker exec nc_redis_master redis-cli -a PMO@123456 ping']));
  }

  if (logContains(logs, 'appendonly', 'aof', 'rdb')) {
    results.push(severity('warning', 'مشکل persistence',
      'خطا در ذخیره AOF یا RDB',
      'دیسک را بررسی کنید',
      ['df -h /data']));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد',
      'لاگ‌ها علت واضحی ندارند',
      'لاگ کامل را بررسی کنید',
      ['docker logs '+name+' --tail 100']));
  }

  return results;
}

async function diagnoseSentinel(name) {
  const results = [];
  const inspect = await getContainerInspect(name);
  const logs = await getContainerLogs(name, 50);

  if (!inspect) return [severity('critical', 'Container پیدا نشد', '', '', [])];

  if (logContains(logs, '+odown', 'objectively down')) {
    results.push(severity('critical', 'Master آفلاین تشخیص داده شد',
      'Sentinel master را objectively down می‌بیند — failover در حال انجام',
      'وضعیت Redis master و نتیجه failover را بررسی کنید',
      ['docker exec '+name+' redis-cli -p 26379 sentinel master nc_master',
       'docker inspect nc_redis_master --format={{.State.Status}}']));
  }

  if (logContains(logs, 'quorum', '-sdown')) {
    results.push(severity('warning', 'مشکل quorum',
      'Sentinel نمی‌تواند quorum کافی جمع کند',
      'وضعیت سایر sentinel‌ها را بررسی کنید',
      ['docker exec '+name+' redis-cli -p 26379 sentinel sentinels nc_master']));
  }

  if (logContains(logs, 'auth', 'NOAUTH')) {
    results.push(severity('critical', 'خطای auth در sentinel',
      'پسورد sentinel با Redis master مطابقت ندارد',
      'auth-pass در sentinel.conf را بررسی کنید',
      ['grep auth-pass /root/nextcloud/conf/redis/sentinel.conf']));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد', '', 'لاگ را بررسی کنید',
      ['docker logs '+name+' --tail 50']));
  }

  return results;
}

async function diagnoseNginx(name) {
  const results = [];
  const inspect = await getContainerInspect(name);
  const logs = await getContainerLogs(name, 50);

  if (!inspect) return [severity('critical', 'Container پیدا نشد', '', '', [])];

  if (logContains(logs, 'emerg', 'configuration file', 'failed')) {
    results.push(severity('critical', 'خطای config Nginx',
      'فایل پیکربندی Nginx دارای خطای syntax است',
      'config را بررسی کنید',
      ['docker exec nc_nginx nginx -t']));
  }

  if (logContains(logs, 'ssl', 'certificate', 'expired')) {
    results.push(severity('critical', 'مشکل SSL Certificate',
      'گواهی SSL منقضی یا نامعتبر است',
      'certificate را تجدید کنید',
      []));
  }

  if (logContains(logs, 'upstream', 'no live upstreams', '502', '504')) {
    results.push(severity('critical', 'App nodes در دسترس نیستند',
      'Nginx نمی‌تواند به nc_app1/2/3 متصل شود',
      'وضعیت app nodes را بررسی کنید',
      ['docker inspect nc_app1 --format={{.State.Status}}',
       'docker inspect nc_app2 --format={{.State.Status}}',
       'docker inspect nc_app3 --format={{.State.Status}}']));
  }

  if (logContains(logs, 'address already in use', 'bind() to')) {
    results.push(severity('critical', 'پورت 80/443 در اشغال است',
      'پروسه دیگری پورت را گرفته',
      'پروسه‌های روی این پورت را بررسی کنید',
      ['ss -tlnp | grep -E ":80|:443"']));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد', '', 'لاگ را بررسی کنید',
      ['docker logs '+name+' --tail 50']));
  }

  return results;
}

async function diagnoseClamav(name) {
  const results = [];
  const inspect = await getContainerInspect(name);
  const logs = await getContainerLogs(name, 50);

  if (!inspect) return [severity('critical', 'Container پیدا نشد', '', '', [])];

  if (logContains(logs, 'malformed database', 'corrupted', 'cli_tgzload')) {
    results.push(severity('critical', 'دیتابیس ویروس آسیب دیده است',
      'فایل main.cvd یا daily.cvd خراب است',
      'دیتابیس را پاک و دوباره دانلود کنید',
      ['ls -lh /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/',
       'docker exec clamav freshclam']));
  }

  if (logContains(logs, 'older than 7 days', 'virus database is older')) {
    results.push(severity('warning', 'دیتابیس ویروس قدیمی است',
      'دیتابیس بیش از ۷ روز آپدیت نشده',
      'freshclam را اجرا کنید',
      ['docker exec clamav freshclam']));
  }

  if (logContains(logs, 'socket', 'clamd.sock', 'not found')) {
    results.push(severity('critical', 'Socket clamd پیدا نشد',
      'ClamAV daemon هنوز راه‌اندازی نشده یا crash کرده',
      'container را ریستارت کنید',
      ['docker restart clamav']));
  }

  if (logContains(logs, 'no space left', 'disk')) {
    results.push(severity('critical', 'دیسک پر است',
      'ClamAV نمی‌تواند دیتابیس را بنویسد',
      'فضای /data را بررسی کنید',
      ['df -h /data']));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد', '', 'لاگ را بررسی کنید',
      ['docker logs clamav --tail 50']));
  }

  return results;
}

async function diagnoseAvScanner(name) {
  const results = [];
  const logs = await getContainerLogs(name, 30);

  if (logContains(logs, 'clamav', 'connection refused', 'ECONNREFUSED')) {
    results.push(severity('critical', 'اتصال به ClamAV قطع است',
      'av_scanner نمی‌تواند به ClamAV daemon متصل شود',
      'وضعیت ClamAV را بررسی کنید',
      ['docker inspect clamav --format={{.State.Health.Status}}',
       'docker logs clamav --tail 20']));
  }

  if (logContains(logs, 'yara', 'error', 'invalid rule')) {
    results.push(severity('warning', 'خطای Yara rules',
      'یک یا چند Yara rule نامعتبر است',
      'rules را از AV Dashboard بررسی کنید',
      []));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد', '', 'لاگ را بررسی کنید',
      ['docker logs '+name+' --tail 50']));
  }

  return results;
}

async function diagnoseMonitoring(name) {
  const results = [];
  const inspect = await getContainerInspect(name);
  const logs = await getContainerLogs(name, 30);

  if (!inspect) return [severity('critical', 'Container پیدا نشد', '', '', [])];

  if (logContains(logs, 'no space left', 'storage full', 'tsdb')) {
    results.push(severity('critical', 'ذخیره‌سازی Prometheus پر است',
      'TSDB دیسک پر شده',
      'retention را کاهش دهید یا فضا آزاد کنید',
      ['df -h /data']));
  }

  if (logContains(logs, 'connection refused', 'dial tcp')) {
    results.push(severity('warning', 'اتصال به target قطع است',
      'Prometheus نمی‌تواند به یک یا چند exporter متصل شود',
      'exporterها را بررسی کنید',
      ['curl -s http://localhost:9090/api/v1/targets | python3 -c "import sys,json;[print(t[\'labels\'][\'job\'],t[\'health\']) for t in json.load(sys.stdin)[\'data\'][\'activeTargets\']]"']));
  }

  if (logContains(logs, 'database locked', 'grafana.db')) {
    results.push(severity('warning', 'Grafana database lock',
      'فایل grafana.db قفل شده',
      'container را ریستارت کنید',
      ['docker restart '+name]));
  }

  if (results.length === 0) {
    results.push(severity('info', 'علت مشخص نشد', '', 'لاگ را بررسی کنید',
      ['docker logs '+name+' --tail 50']));
  }

  return results;
}

// ═══════════════════════════════════════
// Router اصلی — بر اساس نام container
// ═══════════════════════════════════════
async function diagnose(containerName) {
  if (containerName.startsWith('nc_app') || containerName === 'nc_cron') {
    return diagnoseApp(containerName);
  }
  if (containerName.includes('pg_primary') || containerName.includes('pg_replica')) {
    return diagnosePostgres(containerName);
  }
  if (containerName.includes('redis_master') || containerName.includes('redis_replica')) {
    return diagnoseRedis(containerName);
  }
  if (containerName.includes('sentinel')) {
    return diagnoseSentinel(containerName);
  }
  if (containerName === 'nc_nginx') {
    return diagnoseNginx(containerName);
  }
  if (containerName === 'clamav') {
    return diagnoseClamav(containerName);
  }
  if (containerName === 'av_scanner') {
    return diagnoseAvScanner(containerName);
  }
  if (['nc_prometheus','nc_grafana','nc_cadvisor','nc_pg_exporter','nc_redis_exporter','nc_nginx_exporter'].includes(containerName)) {
    return diagnoseMonitoring(containerName);
  }
  if (containerName === 'nc_pgbouncer') {
    return diagnosePostgres(containerName);
  }
  // default
  const logs = await getContainerLogs(containerName, 30);
  return [severity('info', 'بررسی عمومی', 'سرویس آفلاین است', 'لاگ را بررسی کنید',
    ['docker logs '+containerName+' --tail 50'])];
}

module.exports = { diagnose };
