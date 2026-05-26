const http = require('http');
const { exec } = require('child_process');

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════
function dockerApiRaw(p, method, body) {
  return new Promise((resolve) => {
    const opts = {
      socketPath: '/var/run/docker.sock',
      path: p,
      method: method || 'GET',
      headers: {}
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 500, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shellRun(cmd, timeout=15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || stderr || '').trim() });
    });
  });
}

function log(msg) { return { time: new Date().toISOString(), msg }; }

// ═══════════════════════════════════════
// Actions
// ═══════════════════════════════════════
async function containerStart(name) {
  const r = await dockerApiRaw('/containers/'+name+'/start', 'POST');
  return r.status === 204 || r.status === 304;
}

async function containerRestart(name) {
  const r = await dockerApiRaw('/containers/'+name+'/restart', 'POST');
  return r.status === 204;
}

async function containerInspect(name) {
  const r = await dockerApiRaw('/containers/'+name+'/json');
  try { return JSON.parse(r.body); } catch { return null; }
}

async function containerLogs(name, tail=30) {
  const r = await dockerApiRaw('/containers/'+name+'/logs?stdout=1&stderr=1&tail='+tail);
  return r.body.replace(/[\x00-\x08\x0e-\x1f]/g, '');
}

async function dockerExecSimple(container, command) {
  const cb = JSON.stringify({ AttachStdout:true, AttachStderr:true, Cmd:['/bin/sh','-c',command] });
  const cr = await new Promise((resolve) => {
    const req = http.request({
      socketPath:'/var/run/docker.sock', path:'/containers/'+container+'/exec',
      method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(cb)}
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d})); });
    req.on('error', e=>resolve({status:500,body:e.message}));
    req.write(cb); req.end();
  });
  if (cr.status !== 201) return { ok:false, output: cr.body };
  const execId = JSON.parse(cr.body).Id;
  const sb = JSON.stringify({ Detach:false, Tty:false });
  const sr = await new Promise((resolve) => {
    const req = http.request({
      socketPath:'/var/run/docker.sock', path:'/exec/'+execId+'/start',
      method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(sb)}
    }, (res) => { let d=Buffer.alloc(0); res.on('data',c=>{d=Buffer.concat([d,c]);}); res.on('end',()=>resolve({status:res.statusCode,body:d})); });
    req.on('error', e=>resolve({status:500,body:Buffer.from(e.message)}));
    req.write(sb); req.end();
  });
  let out=''; let buf=sr.body; let i=0;
  while(i+8<=buf.length){ const sz=buf.readUInt32BE(i+4); if(i+8+sz<=buf.length) out+=buf.slice(i+8,i+8+sz).toString('utf8'); i+=8+sz; }
  return { ok:true, output: out.trim() || buf.toString('utf8').trim() };
}

// ═══════════════════════════════════════
// Verify helpers
// ═══════════════════════════════════════
async function verifyContainerHealthy(name, waitMs=8000) {
  await sleep(waitMs);
  const info = await containerInspect(name);
  if (!info) return false;
  if (info.State.Running === false) return false;
  if (info.State.Health) return info.State.Health.Status === 'healthy';
  return info.State.Running;
}

async function verifyHttpEndpoint(url, expectStatus=200) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve(res.statusCode === expectStatus || res.statusCode === 302 || res.statusCode === 301);
    }).on('error', () => resolve(false));
  });
}

async function verifyRedisPing(container, pass) {
  const r = await dockerExecSimple(container, 'redis-cli -a '+pass+' ping');
  return r.output.includes('PONG');
}

async function verifyPgReady(container) {
  const r = await dockerExecSimple(container, 'pg_isready -U nextcloud -d nextcloud');
  return r.output.includes('accepting connections');
}

// ═══════════════════════════════════════
// Remediation Plans
// ═══════════════════════════════════════

// ── App Nodes ──────────────────────────
async function remediateApp(name, diagnosis) {
  const steps = [];
  const info = await containerInspect(name);
  if (!info) return { success:false, steps:[log('container پیدا نشد')] };

  const exitCode = info.State.ExitCode;
  const oomKilled = info.State.OOMKilled;
  const restartCount = info.RestartCount || 0;

  // OOM: restart + هشدار
  if (oomKilled) {
    steps.push(log('OOM detected — restart محتاطانه'));
    const ok = await containerStart(name);
    steps.push(log(ok ? name+' start شد' : 'start ناموفق بود'));
    if (ok) {
      const healthy = await verifyContainerHealthy(name, 10000);
      steps.push(log(healthy ? '✓ container سالم است' : '⚠ container راه‌اندازی نشد — بررسی دستی لازم است'));
      steps.push(log('⚠ هشدار: OOM دوباره ممکن است رخ دهد — memory limit را بررسی کنید'));
      return { success: healthy, steps, warning: 'OOM kill احتمال تکرار دارد' };
    }
    return { success: false, steps };
  }

  // restart loop
  if (restartCount > 5) {
    steps.push(log('restart loop شناسایی شد ('+restartCount+' بار) — بررسی لاگ قبل از اقدام'));
    const logs = await containerLogs(name, 20);
    steps.push(log('لاگ آخر: '+logs.slice(-300)));
    steps.push(log('restart با delay...'));
    const ok = await containerRestart(name);
    steps.push(log(ok ? 'restart انجام شد' : 'restart ناموفق'));
    await sleep(15000);
    const healthy = await verifyContainerHealthy(name, 5000);
    steps.push(log(healthy ? '✓ container سالم است' : '✗ هنوز مشکل دارد — بررسی دستی لازم است'));
    return { success: healthy, steps };
  }

  // exit code 0 یا 1: ساده‌ترین حالت — start کن
  if (!info.State.Running) {
    steps.push(log('container متوقف است (exit:'+exitCode+') — start...'));
    const ok = await containerStart(name);
    steps.push(log(ok ? name+' start شد' : 'start ناموفق'));
    if (ok) {
      const healthy = await verifyContainerHealthy(name, 10000);
      steps.push(log(healthy ? '✓ container سالم است' : '✗ container start شد اما healthy نشد'));
      return { success: healthy, steps };
    }
  }

  steps.push(log('اقدام خودکار ممکن نیست — بررسی دستی لازم است'));
  return { success: false, steps };
}

// ── PgBouncer ──────────────────────────
async function remediatePgBouncer(diagnosis) {
  const steps = [];
  const info = await containerInspect('nc_pgbouncer');
  if (!info) return { success:false, steps:[log('container پیدا نشد')] };

  if (!info.State.Running) {
    steps.push(log('PgBouncer متوقف است — start...'));
    const ok = await containerStart('nc_pgbouncer');
    steps.push(log(ok ? 'start شد' : 'start ناموفق'));
    if (ok) {
      await sleep(5000);
      const info2 = await containerInspect('nc_pgbouncer');
      const running = info2 && info2.State.Running;
      steps.push(log(running ? '✓ PgBouncer آنلاین شد' : '✗ start شد اما running نشد'));
      return { success: running, steps };
    }
  }

  steps.push(log('PgBouncer در حال اجراست اما مشکل دارد — restart...'));
  const ok = await containerRestart('nc_pgbouncer');
  steps.push(log(ok ? 'restart انجام شد' : 'restart ناموفق'));
  await sleep(5000);
  const info3 = await containerInspect('nc_pgbouncer');
  const running = info3 && info3.State.Running;
  steps.push(log(running ? '✓ PgBouncer آنلاین شد' : '✗ هنوز مشکل دارد'));
  return { success: running, steps };
}

// ── PostgreSQL ─────────────────────────
async function remediatePostgres(name, diagnosis) {
  const steps = [];
  const info = await containerInspect(name);
  if (!info) return { success:false, steps:[log('container پیدا نشد')] };

  const diagTitles = diagnosis.map(d => d.title).join(' | ');

  // disk full → نمیشه خودکار حل کرد
  if (diagTitles.includes('دیسک پر')) {
    steps.push(log('✗ دیسک پر است — اقدام خودکار ممکن نیست'));
    steps.push(log('→ فضای /data را آزاد کنید: docker system prune -f'));
    return { success:false, steps, manual:true };
  }

  // corruption → نمیشه خودکار حل کرد
  if (diagTitles.includes('آسیب دیده')) {
    steps.push(log('✗ دیتابیس corrupted — restore از backup لازم است'));
    return { success:false, steps, manual:true };
  }

  // max connections → reload
  if (diagTitles.includes('حداکثر connections')) {
    steps.push(log('تلاش برای reload config PostgreSQL...'));
    const r = await dockerExecSimple(name, "psql -U nextcloud -d nextcloud -c 'SELECT pg_reload_conf();'");
    steps.push(log('reload: '+r.output));
    const ok = await verifyPgReady(name);
    steps.push(log(ok ? '✓ PostgreSQL پاسخ می‌دهد' : '✗ هنوز مشکل دارد'));
    return { success:ok, steps };
  }

  // primary — محتاط باشیم
  if (name === 'nc_pg_primary') {
    if (!info.State.Running) {
      steps.push(log('⚠ Primary DB متوقف است — start محتاطانه...'));
      const ok = await containerStart(name);
      steps.push(log(ok ? 'start شد' : 'start ناموفق'));
      if (ok) {
        await sleep(8000);
        const ready = await verifyPgReady(name);
        steps.push(log(ready ? '✓ Primary آماده است' : '✗ Primary راه‌اندازی نشد'));
        return { success:ready, steps };
      }
    }
  }

  // replica — راحت‌تر restart میشه
  if (name.includes('replica')) {
    steps.push(log('Replica restart...'));
    const ok = await containerRestart(name);
    steps.push(log(ok ? 'restart شد' : 'restart ناموفق'));
    await sleep(8000);
    const ready = await verifyPgReady(name);
    steps.push(log(ready ? '✓ Replica آماده است' : '✗ هنوز مشکل دارد'));
    return { success:ready, steps };
  }

  steps.push(log('اقدام خودکار مناسب پیدا نشد'));
  return { success:false, steps };
}

// ── Redis ──────────────────────────────
async function remediateRedis(name, diagnosis) {
  const steps = [];
  const diagTitles = diagnosis.map(d => d.title).join(' | ');
  const PASS = 'PMO@123456';

  // auth مشکل → فقط گزارش
  if (diagTitles.includes('احراز هویت')) {
    steps.push(log('✗ مشکل auth — تغییر config دستی لازم است'));
    steps.push(log('→ REDIS_PASSWORD در .env را بررسی کنید'));
    return { success:false, steps, manual:true };
  }

  // OOM
  if (diagTitles.includes('حافظه Redis پر')) {
    steps.push(log('تلاش برای flush cache...'));
    const r = await dockerExecSimple(name, 'redis-cli -a '+PASS+' flushdb async');
    steps.push(log('flushdb: '+r.output));
    const ping = await verifyRedisPing(name, PASS);
    steps.push(log(ping ? '✓ Redis پاسخ می‌دهد' : '✗ هنوز مشکل دارد'));
    return { success:ping, steps };
  }

  // container متوقف → start
  const info = await containerInspect(name);
  if (info && !info.State.Running) {
    steps.push(log(name+' متوقف است — start...'));
    const ok = await containerStart(name);
    steps.push(log(ok ? 'start شد' : 'start ناموفق'));
    if (ok) {
      await sleep(5000);
      const ping = await verifyRedisPing(name, PASS);
      steps.push(log(ping ? '✓ Redis PONG دریافت شد' : '✗ Redis پاسخ نمی‌دهد'));
      return { success:ping, steps };
    }
  }

  // restart عمومی
  steps.push(log('restart '+name+'...'));
  const ok = await containerRestart(name);
  steps.push(log(ok ? 'restart انجام شد' : 'restart ناموفق'));
  await sleep(5000);
  const ping = await verifyRedisPing(name, PASS);
  steps.push(log(ping ? '✓ Redis PONG دریافت شد' : '✗ هنوز مشکل دارد'));
  return { success:ping, steps };
}

// ── Sentinel ───────────────────────────
async function remediateSentinel(name, diagnosis) {
  const steps = [];
  steps.push(log('restart '+name+'...'));
  const ok = await containerRestart(name);
  steps.push(log(ok ? 'restart انجام شد' : 'restart ناموفق'));
  await sleep(5000);
  const info = await containerInspect(name);
  const running = info && info.State.Running;
  steps.push(log(running ? '✓ Sentinel آنلاین شد' : '✗ هنوز مشکل دارد'));
  if (running) {
    const r = await dockerExecSimple(name, 'redis-cli -p 26379 sentinel master nc_master');
    steps.push(log('master info: '+(r.output.slice(0,100)||'N/A')));
  }
  return { success:running, steps };
}

// ── Nginx ──────────────────────────────
async function remediateNginx(diagnosis) {
  const steps = [];
  const diagTitles = diagnosis.map(d => d.title).join(' | ');

  // config error
  if (diagTitles.includes('config')) {
    steps.push(log('تست nginx config...'));
    const r = await dockerExecSimple('nc_nginx', 'nginx -t');
    steps.push(log('nginx -t: '+r.output));
    if (!r.output.includes('successful')) {
      steps.push(log('✗ config مشکل دارد — اصلاح دستی لازم است'));
      return { success:false, steps, manual:true };
    }
  }

  steps.push(log('reload nginx...'));
  const r2 = await dockerExecSimple('nc_nginx', 'nginx -s reload');
  steps.push(log('reload: '+(r2.output||'ok')));
  await sleep(3000);
  const httpOk = await verifyHttpEndpoint('http://localhost:80');
  steps.push(log(httpOk ? '✓ Nginx پاسخ می‌دهد' : '✗ HTTP check ناموفق — restart...'));

  if (!httpOk) {
    const ok = await containerRestart('nc_nginx');
    steps.push(log(ok ? 'restart انجام شد' : 'restart ناموفق'));
    await sleep(5000);
    const httpOk2 = await verifyHttpEndpoint('http://localhost:80');
    steps.push(log(httpOk2 ? '✓ Nginx آنلاین شد' : '✗ هنوز مشکل دارد'));
    return { success:httpOk2, steps };
  }

  return { success:true, steps };
}

// ── ClamAV ─────────────────────────────
async function remediateClamav(diagnosis) {
  const steps = [];
  const diagTitles = diagnosis.map(d => d.title).join(' | ');

  // DB corrupted
  if (diagTitles.includes('آسیب دیده') || diagTitles.includes('corrupted')) {
    steps.push(log('دیتابیس ClamAV خراب است — پاک کردن...'));
    const r = await shellRun('rm -f /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/main.cvd /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/main.cld /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/daily.cvd /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/daily.cld');
    steps.push(log('پاک شد: '+( r.ok ? 'ok' : r.output)));
    steps.push(log('restart ClamAV برای دانلود مجدد DB...'));
    const ok = await containerRestart('clamav');
    steps.push(log(ok ? 'restart شد — DB در حال دانلود است (چند دقیقه)' : 'restart ناموفق'));
    steps.push(log('⚠ بررسی مجدد health بعد از ۳ دقیقه لازم است'));
    return { success:ok, steps, warning:'DB دانلود ممکن است چند دقیقه طول بکشد' };
  }

  // DB قدیمی
  if (diagTitles.includes('قدیمی')) {
    steps.push(log('اجرای freshclam برای آپدیت DB...'));
    const r = await dockerExecSimple('clamav', 'freshclam');
    steps.push(log('freshclam: '+r.output.slice(0,200)));
    const ok = r.output.includes('up to date') || r.output.includes('updated');
    steps.push(log(ok ? '✓ DB آپدیت شد' : '⚠ freshclam اجرا شد — نتیجه را بررسی کنید'));
    return { success:ok, steps };
  }

  // عمومی — restart
  steps.push(log('restart ClamAV...'));
  const ok = await containerRestart('clamav');
  steps.push(log(ok ? 'restart شد' : 'restart ناموفق'));
  await sleep(10000);
  const info = await containerInspect('clamav');
  const healthy = info && info.State.Health && info.State.Health.Status === 'healthy';
  steps.push(log(healthy ? '✓ ClamAV healthy شد' : '⚠ هنوز در حال راه‌اندازی — چند دقیقه صبر کنید'));
  return { success:healthy, steps };
}

// ── Monitoring ─────────────────────────
async function remediateMonitoring(name, diagnosis) {
  const steps = [];
  const diagTitles = diagnosis.map(d => d.title).join(' | ');

  if (diagTitles.includes('ذخیره‌سازی')) {
    steps.push(log('✗ storage پر است — اقدام خودکار ممکن نیست'));
    steps.push(log('→ retention_time را در prometheus.yml کاهش دهید'));
    return { success:false, steps, manual:true };
  }

  steps.push(log('restart '+name+'...'));
  const ok = await containerRestart(name);
  steps.push(log(ok ? 'restart شد' : 'restart ناموفق'));
  await sleep(5000);
  const info = await containerInspect(name);
  const running = info && info.State.Running;
  steps.push(log(running ? '✓ '+name+' آنلاین شد' : '✗ هنوز مشکل دارد'));
  return { success:running, steps };
}

// ── AV Scanner ─────────────────────────
async function remediateAvScanner(name, diagnosis) {
  const steps = [];
  steps.push(log('restart '+name+'...'));
  const ok = await containerRestart(name);
  steps.push(log(ok ? 'restart شد' : 'restart ناموفق'));
  await sleep(5000);
  const r = await shellRun('curl -s http://localhost:8000/');
  const apiOk = r.output.includes('scanner') || r.output.includes('version');
  steps.push(log(apiOk ? '✓ AV Scanner API پاسخ می‌دهد' : '✗ API هنوز پاسخ نمی‌دهد'));
  return { success:apiOk, steps };
}

// ── General fallback ───────────────────
async function remediateGeneral(name) {
  const steps = [];
  const info = await containerInspect(name);
  if (!info) return { success:false, steps:[log('container پیدا نشد')] };
  if (!info.State.Running) {
    steps.push(log('container متوقف است — start...'));
    const ok = await containerStart(name);
    steps.push(log(ok ? 'start شد' : 'start ناموفق'));
    await sleep(5000);
    const info2 = await containerInspect(name);
    const running = info2 && info2.State.Running;
    steps.push(log(running ? '✓ container آنلاین شد' : '✗ هنوز مشکل دارد'));
    return { success:running, steps };
  }
  steps.push(log('container در حال اجراست — restart...'));
  const ok = await containerRestart(name);
  steps.push(log(ok ? 'restart شد' : 'restart ناموفق'));
  await sleep(5000);
  const info3 = await containerInspect(name);
  const running = info3 && info3.State.Running;
  steps.push(log(running ? '✓ آنلاین شد' : '✗ هنوز مشکل دارد'));
  return { success:running, steps };
}

// ═══════════════════════════════════════
// Router اصلی
// ═══════════════════════════════════════
async function remediate(containerName, diagnosis) {
  if (containerName.startsWith('nc_app') || containerName === 'nc_cron')
    return remediateApp(containerName, diagnosis);
  if (containerName === 'nc_pgbouncer')
    return remediatePgBouncer(diagnosis);
  if (containerName.includes('pg_primary') || containerName.includes('pg_replica'))
    return remediatePostgres(containerName, diagnosis);
  if (containerName.includes('redis_master') || containerName.includes('redis_replica'))
    return remediateRedis(containerName, diagnosis);
  if (containerName.includes('sentinel'))
    return remediateSentinel(containerName, diagnosis);
  if (containerName === 'nc_nginx')
    return remediateNginx(diagnosis);
  if (containerName === 'clamav')
    return remediateClamav(diagnosis);
  if (containerName === 'av_scanner' || containerName === 'av_dashboard' || containerName === 'av_log_collector' || containerName === 'av_topology')
    return remediateAvScanner(containerName, diagnosis);
  if (['nc_prometheus','nc_grafana','nc_cadvisor','nc_pg_exporter','nc_redis_exporter','nc_nginx_exporter'].includes(containerName))
    return remediateMonitoring(containerName, diagnosis);
  return remediateGeneral(containerName);
}

module.exports = { remediate };

// ═══════════════════════════════════════
// Streaming version
// ═══════════════════════════════════════
async function remediateStream(containerName, diagnosis, onStep) {
  // wrap log تا onStep هم صدا بزنه
  const streamLog = (msg) => {
    const s = log(msg);
    onStep(s);
    return s;
  };

  // تابع‌های helper که از streamLog استفاده می‌کنن
  async function startContainer(name) {
    streamLog('▶ start ' + name + '...');
    const ok = await containerStart(name);
    streamLog(ok ? '✓ container start شد' : '✗ start ناموفق');
    return ok;
  }

  async function restartContainer(name) {
    streamLog('↺ restart ' + name + '...');
    const ok = await containerRestart(name);
    streamLog(ok ? '✓ restart انجام شد' : '✗ restart ناموفق');
    return ok;
  }

  async function waitAndVerify(name, ms, verifyFn, successReason, failReason) {
    streamLog('⏳ صبر برای راه‌اندازی (' + (ms/1000) + ' ثانیه)...');
    await sleep(ms);
    streamLog('🔍 بررسی وضعیت...');
    const ok = await verifyFn();
    if(ok) {
      streamLog('✓ سرویس سالم است');
      if(successReason) streamLog('💡 ' + successReason);
    } else {
      streamLog('✗ سرویس هنوز مشکل دارد');
      if(failReason) streamLog('⚠ ' + failReason);
    }
    return ok;
  }

  const diagTitles = (diagnosis || []).map(d => d.title || '').join(' | ');
  const info = await containerInspect(containerName);

  streamLog('🔎 شروع بررسی: ' + containerName);

  if (!info) {
    streamLog('✗ container پیدا نشد');
    return { success: false, steps: [] };
  }

  // ── App Nodes ──
  if (containerName.startsWith('nc_app') || containerName === 'nc_cron') {
    streamLog('📦 نوع سرویس: Nextcloud App Node');
    const oom = info.State.OOMKilled;
    const restarts = info.RestartCount || 0;
    const running = info.State.Running;
    const exitCode = info.State.ExitCode;

    if (oom) {
      streamLog('⚠ OOM Kill شناسایی شد — سیستم‌عامل به دلیل کمبود RAM این container را kill کرده بود');
      const ok = await startContainer(containerName);
      if (ok) {
        const healthy = await waitAndVerify(containerName, 10000, () => verifyContainerHealthy(containerName, 0),
          'container با موفقیت راه‌اندازی شد — PHP-FPM آماده دریافت request است',
          'container start شد اما healthy نشد — احتمالاً OOM دوباره رخ داده');
        streamLog('⚠ هشدار: OOM ممکن است تکرار شود — memory limit را بررسی کنید');
        return { success: healthy, warning: 'OOM kill — بررسی memory لازم است' };
      }
      return { success: false };
    }

    if (restarts > 5) {
      streamLog('⚠ restart loop: ' + restarts + ' بار ریستارت شده — احتمال crash loop');
      streamLog('📋 بررسی لاگ‌های اخیر...');
      const logs = await containerLogs(containerName, 10);
      const lastLine = logs.trim().split('\n').pop() || '';
      streamLog('📄 آخرین لاگ: ' + lastLine.slice(0, 120));
      const ok = await restartContainer(containerName);
      if (ok) {
        const healthy = await waitAndVerify(containerName, 15000, () => verifyContainerHealthy(containerName, 0),
          'container پایدار شد — restart loop متوقف شد',
          'container هنوز crash می‌کند — بررسی دستی لاگ‌ها لازم است');
        return { success: healthy };
      }
      return { success: false };
    }

    if (!running) {
      streamLog('📦 container متوقف است (exit code: ' + exitCode + ')');
      const ok = await startContainer(containerName);
      if (ok) {
        const healthy = await waitAndVerify(containerName, 10000, () => verifyContainerHealthy(containerName, 0));
        return { success: healthy };
      }
      return { success: false };
    }

    streamLog('⚠ container در حال اجراست اما مشکل دارد');
    const ok = await restartContainer(containerName);
    if (ok) {
      const healthy = await waitAndVerify(containerName, 10000, () => verifyContainerHealthy(containerName, 0));
      return { success: healthy };
    }
    return { success: false };
  }

  // ── PgBouncer ──
  if (containerName === 'nc_pgbouncer') {
    streamLog('📦 نوع سرویس: PgBouncer (Connection Pool)');
    if (!info.State.Running) {
      streamLog('🔌 اتصال به PostgreSQL Primary بررسی می‌شود...');
      const pgInfo = await containerInspect('nc_pg_primary');
      if (!pgInfo || !pgInfo.State.Running) {
        streamLog('⚠ PostgreSQL Primary هم آفلاین است — ابتدا Primary باید start شود');
      }
      const ok = await startContainer(containerName);
      if (ok) {
        const healthy = await waitAndVerify(containerName, 5000, async () => {
          const i = await containerInspect(containerName);
          return i && i.State.Running;
        },
        'PgBouncer آنلاین شد — connection pooling برای nc_app1/2/3 فعال است',
        'PgBouncer start شد اما running نشد');
        return { success: healthy };
      }
    } else {
      streamLog('🔄 PgBouncer در حال اجراست اما مشکل دارد — restart...');
      const ok = await restartContainer(containerName);
      if (ok) {
        const healthy = await waitAndVerify(containerName, 5000, async () => {
          const i = await containerInspect(containerName);
          return i && i.State.Running;
        },
        'PgBouncer پس از restart آنلاین شد — اتصالات DB برقرار است',
        'restart انجام شد اما PgBouncer running نشد');
        return { success: healthy };
      }
    }
    return { success: false };
  }

  // ── PostgreSQL ──
  if (containerName.includes('pg_')) {
    streamLog('📦 نوع سرویس: PostgreSQL ' + (containerName.includes('primary') ? 'Primary' : 'Replica'));

    if (diagTitles.includes('دیسک پر')) {
      streamLog('✗ دیسک پر است — اقدام خودکار ممکن نیست');
      streamLog('→ دستور پیشنهادی: docker system prune -f');
      streamLog('→ سپس: df -h /data');
      return { success: false, manual: true };
    }
    if (diagTitles.includes('آسیب دیده')) {
      streamLog('✗ corruption شناسایی شد — restore از backup لازم است');
      return { success: false, manual: true };
    }
    if (diagTitles.includes('حداکثر connections')) {
      streamLog('🔄 تلاش برای reload config...');
      const r = await dockerExecSimple(containerName, "psql -U nextcloud -d nextcloud -c 'SELECT pg_reload_conf();'");
      streamLog('reload: ' + r.output.slice(0,80));
      const ok = await waitAndVerify(containerName, 3000, () => verifyPgReady(containerName));
      return { success: ok };
    }

    if (containerName.includes('primary')) {
      streamLog('⚠ Primary DB — با احتیاط start می‌شود');
    }
    const ok = await startContainer(containerName);
    if (ok) {
      const healthy = await waitAndVerify(containerName, 8000, () => verifyPgReady(containerName),
        containerName.includes('primary')
          ? 'PostgreSQL Primary آماده است — PgBouncer می‌تواند متصل شود و replication با replica1/2 برقرار می‌شود'
          : 'PostgreSQL Replica آماده است — streaming replication از primary ادامه می‌یابد',
        'PostgreSQL start شد اما pg_isready ناموفق بود — لاگ را بررسی کنید');
      return { success: healthy };
    }
    return { success: false };
  }

  // ── Redis ──
  if (containerName.includes('redis_')) {
    streamLog('📦 نوع سرویس: Redis ' + (containerName.includes('master') ? 'Master' : 'Replica'));
    const PASS = 'PMO@123456';

    if (diagTitles.includes('احراز هویت')) {
      streamLog('✗ مشکل auth — بررسی پسورد لازم است');
      streamLog('→ REDIS_PASSWORD در .env را بررسی کنید');
      return { success: false, manual: true };
    }
    if (diagTitles.includes('حافظه Redis پر')) {
      streamLog('🗑 flush cache...');
      const r = await dockerExecSimple(containerName, 'redis-cli -a '+PASS+' flushdb async');
      streamLog('flushdb: ' + r.output);
      const ping = await waitAndVerify(containerName, 2000, () => verifyRedisPing(containerName, PASS));
      return { success: ping };
    }

    if (!info.State.Running) {
      const ok = await startContainer(containerName);
      if (ok) {
        const ping = await waitAndVerify(containerName, 5000, () => verifyRedisPing(containerName, PASS),
          'Redis PONG دریافت شد — cache و session مجدداً فعال هستند',
          'Redis start شد اما PING ناموفق بود — احتمال مشکل auth');
        return { success: ping };
      }
    } else {
      const ok = await restartContainer(containerName);
      if (ok) {
        const ping = await waitAndVerify(containerName, 5000, () => verifyRedisPing(containerName, PASS),
          'Redis پس از restart سالم شد — replication با replica1/2 برقرار می‌شود',
          'restart انجام شد اما PING ناموفق — لاگ را بررسی کنید');
        return { success: ping };
      }
    }
    return { success: false };
  }

  // ── Sentinel ──
  if (containerName.includes('sentinel')) {
    streamLog('📦 نوع سرویس: Redis Sentinel');
    const ok = await restartContainer(containerName);
    if (ok) {
      streamLog('🔍 بررسی شناخت master...');
      await sleep(5000);
      const r = await dockerExecSimple(containerName, 'redis-cli -p 26379 sentinel master nc_master');
      const masterOk = r.output.includes('nc_master') || r.output.includes('ip');
      if(masterOk) {
        streamLog('✓ master شناخته شد');
        streamLog('💡 Sentinel مجدداً nc_redis_master را monitor می‌کند — quorum برقرار است');
      } else {
        streamLog('⚠ master هنوز شناخته نشده — چند ثانیه دیگر دوباره بررسی کنید');
      }
      return { success: masterOk };
    }
    return { success: false };
  }

  // ── Nginx ──
  if (containerName === 'nc_nginx') {
    streamLog('📦 نوع سرویس: Nginx Load Balancer');
    streamLog('🔍 تست config...');
    const configTest = await dockerExecSimple('nc_nginx', 'nginx -t');
    streamLog('nginx -t: ' + configTest.output.slice(0,100));
    if (!configTest.output.includes('successful')) {
      streamLog('✗ config مشکل دارد — اصلاح دستی لازم است');
      return { success: false, manual: true };
    }
    streamLog('✓ config سالم است');
    streamLog('🔄 reload nginx...');
    await dockerExecSimple('nc_nginx', 'nginx -s reload');
    const httpOk = await waitAndVerify(containerName, 3000, () => verifyHttpEndpoint('http://localhost:80'));
    if (!httpOk) {
      const ok = await restartContainer('nc_nginx');
      if (ok) {
        const httpOk2 = await waitAndVerify(containerName, 5000, () => verifyHttpEndpoint('http://localhost:80'));
        return { success: httpOk2 };
      }
    }
    return { success: httpOk };
  }

  // ── ClamAV ──
  if (containerName === 'clamav') {
    streamLog('📦 نوع سرویس: ClamAV Antivirus');
    if (diagTitles.includes('آسیب دیده') || diagTitles.includes('corrupted')) {
      streamLog('🗑 پاک کردن دیتابیس خراب...');
      await shellRun('rm -f /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/main.cvd /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/main.cld /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/daily.cvd /data/docker/volumes/nextcloud-antivirus_clamav_db/_data/daily.cld');
      streamLog('✓ فایل‌های خراب پاک شدند');
      streamLog('▶ restart برای دانلود مجدد DB...');
      const ok = await containerRestart('clamav');
      streamLog(ok ? '✓ restart شد — DB در حال دانلود است' : '✗ restart ناموفق');
      streamLog('⏳ دانلود DB چند دقیقه طول می‌کشد');
      return { success: ok, warning: 'DB دانلود ممکن است ۳-۵ دقیقه طول بکشد' };
    }
    if (diagTitles.includes('قدیمی')) {
      streamLog('🔄 اجرای freshclam...');
      const r = await dockerExecSimple('clamav', 'freshclam');
      streamLog('freshclam: ' + r.output.slice(0,150));
      return { success: true };
    }
    const ok = await restartContainer('clamav');
    if (ok) {
      streamLog('⏳ صبر برای راه‌اندازی ClamAV (۱۰ ثانیه)...');
      await sleep(10000);
      const i = await containerInspect('clamav');
      const healthy = i && i.State.Health && i.State.Health.Status === 'healthy';
      streamLog(healthy ? '✓ ClamAV healthy' : '⏳ هنوز در حال راه‌اندازی');
      return { success: healthy };
    }
    return { success: false };
  }

  // ── General ──
  streamLog('📦 نوع سرویس: عمومی');
  if (!info.State.Running) {
    const ok = await startContainer(containerName);
    if (ok) {
      const healthy = await waitAndVerify(containerName, 5000, async () => {
        const i = await containerInspect(containerName);
        return i && i.State.Running;
      });
      return { success: healthy };
    }
  } else {
    const ok = await restartContainer(containerName);
    if (ok) {
      const healthy = await waitAndVerify(containerName, 5000, async () => {
        const i = await containerInspect(containerName);
        return i && i.State.Running;
      });
      return { success: healthy };
    }
  }
  return { success: false };
}

module.exports = { remediate, remediateStream };
