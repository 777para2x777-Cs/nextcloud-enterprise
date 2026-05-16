var currentFilter = 'all';
var currentPage = 1;

function showTab(tab) {
  ['scans','report','quarantine','update'].forEach(function(t) {
    document.getElementById('tab-'+t).style.display = t===tab ? 'block' : 'none';
    document.getElementById('tab-btn-'+t).classList.toggle('active', t===tab);
  });
  if (tab === 'quarantine') loadQuarantine();
  if (tab === 'update') loadYaraList();
  if (tab === 'report') { loadUsers(); loadReport(); }
}

document.getElementById('tab-btn-scans').onclick = function() { showTab('scans'); };
document.getElementById('tab-btn-report').onclick = function() { showTab('report'); };
document.getElementById('tab-btn-quarantine').onclick = function() { showTab('quarantine'); };
document.getElementById('tab-btn-update').onclick = function() { showTab('update'); };
document.getElementById('btn-logout').onclick = function() { fetch('/logout', {headers: {'Authorization': 'Basic ' + btoa('logout:logout')}}).then(function() { window.location.href = '/logout'; }); };
document.getElementById('f-all').onclick = function() { setFilter('all', this); };
document.getElementById('f-infected').onclick = function() { setFilter('infected', this); };
document.getElementById('f-clean').onclick = function() { setFilter('clean', this); };
document.getElementById('filter-user').onchange = function() { loadScans(); };
document.getElementById('report-user').onchange = function() { loadReport(); };
document.getElementById('report-from').onchange = function() { loadReport(); };
document.getElementById('report-to').onchange = function() { loadReport(); };
document.getElementById('btn-report').onclick = function() { loadReport(); };
document.getElementById('btn-export').onclick = function() { exportReport(); };
document.getElementById('btn-yara-list').onclick = function() { loadYaraList(); };
document.getElementById('clamav-area').onclick = function() { document.getElementById('clamav-file').click(); };
document.getElementById('clamav-file').onchange = function() { if (this.files[0]) uploadClamAV(this.files[0]); };
document.getElementById('yara-area').onclick = function() { document.getElementById('yara-file').click(); };
document.getElementById('yara-file').onchange = function() { if (this.files[0]) uploadYara(this.files[0]); };

function loadStatus() {
  fetch('/api/status').then(function(r) { return r.json(); }).then(function(r) {
    document.getElementById('s-total').textContent = r.stats.totalScanned;
    document.getElementById('s-clean').textContent = r.stats.totalClean;
    document.getElementById('s-infected').textContent = r.stats.totalInfected;
    document.getElementById('s-quarantine').textContent = r.stats.totalQuarantined;
    document.getElementById('engines').innerHTML = r.engines.map(function(e) {
      return '<div class="engine"><div class="engine-name"><span class="dot ' + e.status + '"></span>' + e.name +
        ' <span style="font-size:11px;color:#94a3b8">[' + (e.status==='online'?'آنلاین':'آفلاین') + ']</span></div>' +
        '<div class="engine-info">نسخه: ' + e.version + '<br>آدرس: ' + e.host + ':' + e.port + '</div></div>';
    }).join('');
  }).catch(function() {});
}

function loadUsers() {
  fetch('/api/users').then(function(r) { return r.json(); }).then(function(r) {
    var opts = r.users.map(function(u) { return '<option value="' + u + '">' + u + '</option>'; }).join('');
    document.getElementById('filter-user').innerHTML = '<option value="">همه کاربران</option>' + opts;
    document.getElementById('report-user').innerHTML = '<option value="">همه کاربران</option>' + opts;
  }).catch(function() {});
}

function setFilter(f, btn) {
  currentFilter = f; currentPage = 1;
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  loadScans();
}

function loadScans() {
  var user = document.getElementById('filter-user').value;
  var url = '/api/scans?filter=' + currentFilter + '&page=' + currentPage + '&limit=50';
  if (user) url += '&user=' + encodeURIComponent(user);
  fetch(url).then(function(r) { return r.json(); }).then(function(r) {
    var b = document.getElementById('scans-body');
    if (!r.scans || !r.scans.length) {
      b.innerHTML = '<tr><td colspan="6" class="empty">داده‌ای وجود ندارد</td></tr>';
    } else {
      b.innerHTML = r.scans.map(function(s) {
        return '<tr><td>' + (s.filename||'—') + '</td><td>' + (s.user||'—') + '</td>' +
          '<td>' + new Date(s.scannedAt).toLocaleString('fa-IR') + '</td>' +
          '<td><span class="badge ' + (s.infected?'infected':'clean') + '">' + (s.infected?'آلوده':'سالم') + '</span></td>' +
          '<td style="color:#f87171">' + (s.threat||'—') + '</td>' +
          '<td>' + (s.engine||'ClamAV') + '</td></tr>';
      }).join('');
    }
    var pg = document.getElementById('pagination');
    if (r.pages > 1) {
      var pages = '';
      for (var i = 1; i <= r.pages; i++) {
        pages += '<button class="page-btn' + (i===currentPage?' active':'') + '" onclick="goPage(' + i + ')">' + i + '</button>';
      }
      pg.innerHTML = pages;
    } else { pg.innerHTML = ''; }
  }).catch(function() {});
}

function goPage(p) { currentPage = p; loadScans(); }

function loadReport() {
  var user = document.getElementById('report-user').value;
  var from = document.getElementById('report-from').value;
  var to = document.getElementById('report-to').value;
  var url = '/api/report?x=1';
  if (user) url += '&user=' + encodeURIComponent(user);
  if (from) url += '&from=' + from + 'T00:00:00';
  if (to) url += '&to=' + to + 'T23:59:59';
  fetch(url).then(function(r) { return r.json(); }).then(function(r) {
    document.getElementById('report-summary').innerHTML =
      '<div class="card"><div class="label">کل</div><div class="value blue">' + r.total + '</div></div>' +
      '<div class="card"><div class="label">سالم</div><div class="value green">' + r.clean + '</div></div>' +
      '<div class="card"><div class="label">آلوده</div><div class="value red">' + r.infected + '</div></div>';
    var userRows = Object.entries(r.byUser).map(function(e) {
      return '<div class="report-row"><span>' + e[0] + '</span>' +
        '<span><span style="color:#4ade80">' + e[1].clean + '</span> / <span style="color:#f87171">' + e[1].infected + '</span></span></div>';
    }).join('');
    document.getElementById('report-by-user').innerHTML = userRows || '<div class="empty" style="padding:12px">داده‌ای وجود ندارد</div>';
    var dateRows = Object.entries(r.byDate).sort(function(a,b) { return b[0].localeCompare(a[0]); }).slice(0,30).map(function(e) {
      return '<div class="report-row"><span>' + e[0] + '</span>' +
        '<span><span style="color:#4ade80">' + e[1].clean + '</span> / <span style="color:#f87171">' + e[1].infected + '</span></span></div>';
    }).join('');
    document.getElementById('report-by-date').innerHTML = dateRows || '<div class="empty" style="padding:12px">داده‌ای وجود ندارد</div>';
  }).catch(function() {});
}

function exportReport() {
  var user = document.getElementById('report-user').value;
  var from = document.getElementById('report-from').value;
  var to = document.getElementById('report-to').value;
  var url = '/api/scans?limit=5000&x=1';
  if (user) url += '&user=' + encodeURIComponent(user);
  if (from) url += '&from=' + from + 'T00:00:00';
  if (to) url += '&to=' + to + 'T23:59:59';
  fetch(url).then(function(r) { return r.json(); }).then(function(r) {
    var rows = [['نام فایل','یوزر','تاریخ','وضعیت','تهدید','موتور']];
    r.scans.forEach(function(s) {
      rows.push([s.filename, s.user, new Date(s.scannedAt).toLocaleString('fa-IR'), s.infected?'آلوده':'سالم', s.threat||'', s.engine||'']);
    });
    var csv = rows.map(function(row) { return row.join(','); }).join('\n');
    var blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'av_report_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
  }).catch(function() {});
}

function loadQuarantine() {
  fetch('/api/quarantine').then(function(r) { return r.json(); }).then(function(r) {
    var b = document.getElementById('q-body');
    if (!r.files || !r.files.length) {
      b.innerHTML = '<tr><td colspan="4" class="empty">Quarantine خالی است</td></tr>';
    } else {
      b.innerHTML = r.files.map(function(f) {
        return '<tr><td>' + f.name + '</td><td>' + (f.size/1024/1024).toFixed(2) + ' MB</td>' +
          '<td>' + new Date(f.quarantinedAt).toLocaleString('fa-IR') + '</td>' +
          '<td><button class="btn btn-danger" onclick="delQ(\'' + f.name + '\')">حذف</button></td></tr>';
      }).join('');
    }
  }).catch(function() {});
}

function delQ(name) {
  if (!confirm('حذف شود؟')) return;
  fetch('/api/quarantine/' + name, {method:'DELETE'}).then(function() { loadQuarantine(); loadStatus(); });
}

function uploadClamAV(file) {
  var prog = document.getElementById('clamav-progress');
  var result = document.getElementById('clamav-result');
  prog.style.display = 'block'; result.style.display = 'none';
  var fd = new FormData(); fd.append('file', file);
  fetch('/api/update/clamav', {method:'POST', body:fd}).then(function(r) {
    return r.json().then(function(d) { return {ok:r.ok, d:d}; });
  }).then(function(res) {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg ' + (res.ok?'success':'error');
    result.textContent = (res.ok?'موفق: ':'خطا: ') + (res.d.message||res.d.error||'');
  }).catch(function() {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg error'; result.textContent = 'خطا در ارتباط';
  });
}

function uploadYara(file) {
  var prog = document.getElementById('yara-progress');
  var result = document.getElementById('yara-result');
  prog.style.display = 'block'; result.style.display = 'none';
  var fd = new FormData(); fd.append('file', file);
  fetch('/api/update/yara', {method:'POST', body:fd}).then(function(r) {
    return r.json().then(function(d) { return {ok:r.ok, d:d}; });
  }).then(function(res) {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg ' + (res.ok?'success':'error');
    result.textContent = (res.ok?'موفق: ':'خطا: ') + (res.d.message||res.d.error||'');
    if (res.ok) loadYaraList();
  }).catch(function() {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg error'; result.textContent = 'خطا در ارتباط';
  });
}

async function loadYaraList() {
  var container = document.getElementById('yara-rules-list');
  fetch('/api/update/yara/list').then(function(r) { return r.json(); }).then(function(r) {
    if (!r.rules || !r.rules.length) {
      container.innerHTML = '<div class="empty" style="padding:12px">هیچ rule ای وجود ندارد</div>';
    } else {
      container.innerHTML = '<div onclick="toggleRulesList(this)" style="cursor:pointer;padding:10px 12px;background:#1e293b;border-radius:6px;display:flex;justify-content:space-between;align-items:center">' +
        '<span>📋 تعداد rules: <strong style="color:#38bdf8">' + r.rules.length + '</strong></span>' +
        '<span id="rules-toggle-icon" style="color:#94a3b8">▼ نمایش</span>' +
        '</div>' +
        '<div id="rules-list-items" style="display:none;margin-top:8px;max-height:300px;overflow-y:auto">' +
        r.rules.map(function(rule) {
          return '<div style="padding:6px 12px;font-size:12px;color:#94a3b8;border-bottom:1px solid #1e293b">' + rule + '</div>';
        }).join('') +
        '</div>';
    }
  }).catch(function() {
    container.innerHTML = '<div class="empty" style="padding:12px;color:#f87171">خطا</div>';
  });
}

function toggleRulesList(el) {
  var list = document.getElementById('rules-list-items');
  var icon = document.getElementById('rules-toggle-icon');
  if (list.style.display === 'none') {
    list.style.display = 'block';
    icon.textContent = '▲ پنهان';
  } else {
    list.style.display = 'none';
    icon.textContent = '▼ نمایش';
  }
}


function deleteYara(name) {
  if (!confirm('Rule "' + name + '" حذف شود؟')) return;
  fetch('/api/update/yara/' + name, {method:'DELETE'}).then(function() { loadYaraList(); });
}

loadStatus(); loadScans(); loadUsers();
setInterval(function() { loadStatus(); loadScans(); }, 30000);

// ── Engines Tab ──────────────────────────────────────────────
document.getElementById('tab-btn-engines').onclick = function() { showTab('engines'); };

function showTab(tab) {
  ['scans','report','quarantine','update','engines'].forEach(function(t) {
    var el = document.getElementById('tab-'+t);
    var btn = document.getElementById('tab-btn-'+t);
    if (el) el.style.display = t===tab ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', t===tab);
  });
  if (tab === 'quarantine') loadQuarantine();
  if (tab === 'update') loadYaraList();
  if (tab === 'report') { loadUsers(); loadReport(); }
  if (tab === 'engines') loadEngines();
}

document.getElementById('btn-add-engine').onclick = function() {
  document.getElementById('add-engine-form').style.display = 'block';
  toggleEngineFields();
};
document.getElementById('btn-cancel-engine').onclick = function() {
  document.getElementById('add-engine-form').style.display = 'none';
};
document.getElementById('btn-save-engine').onclick = function() { saveEngine(); };

function toggleEngineFields() {
  var type = document.getElementById('eng-type').value;
  document.getElementById('eng-field-host').style.display = type === 'clamav' ? 'block' : 'none';
  document.getElementById('eng-field-port').style.display = type === 'clamav' ? 'block' : 'none';
  document.getElementById('eng-field-url').style.display = (type === 'rest_api') ? 'block' : 'none';
  document.getElementById('eng-field-apikey').style.display = (type === 'rest_api' || type === 'virustotal') ? 'block' : 'none';
}

function loadEngines() {
  fetch('/api/engines').then(function(r) { return r.json(); }).then(function(r) {
    var list = document.getElementById('engines-list');
    if (!r.engines || !r.engines.length) {
      list.innerHTML = '<div class="empty" style="padding:12px">موتوری تعریف نشده</div>';
      return;
    }
    list.innerHTML = r.engines.map(function(e) {
      return '<div class="rule-item" style="margin-bottom:8px;padding:12px">' +
        '<div>' +
          '<span style="font-weight:bold">' + e.name + '</span>' +
          ' <span style="font-size:11px;background:#1e293b;padding:2px 8px;border-radius:10px;color:#94a3b8">' + e.type + '</span>' +
          (e.enabled ? ' <span style="color:#4ade80;font-size:11px">فعال</span>' : ' <span style="color:#f87171;font-size:11px">غیرفعال</span>') +
          '<br><span style="font-size:11px;color:#94a3b8">' + (e.description||'') + '</span>' +
        '</div>' +
        '<div>' +
          '<button class="btn btn-primary" onclick="toggleEngine(\'' + e.id + '\',' + !e.enabled + ')" style="font-size:11px;padding:3px 8px">' + (e.enabled?'غیرفعال':'فعال') + '</button>' +
          (e.id !== 'clamav_1' && e.id !== 'yara_1' ?
            '<button class="btn btn-danger" onclick="deleteEngine(\'' + e.id + '\')" style="font-size:11px;padding:3px 8px">حذف</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }).catch(function() {});
}

function toggleEngine(id, enabled) {
  fetch('/api/engines').then(function(r) { return r.json(); }).then(function(r) {
    var engine = r.engines.find(function(e) { return e.id === id; });
    if (!engine) return;
    engine.enabled = enabled;
    return fetch('/api/engines/' + id, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(engine)});
  }).then(function() { loadEngines(); }).catch(function() {});
}

function deleteEngine(id) {
  if (!confirm('این موتور حذف شود؟')) return;
  fetch('/api/engines/' + id, {method:'DELETE'}).then(function() { loadEngines(); }).catch(function() {});
}

function saveEngine() {
  var type = document.getElementById('eng-type').value;
  var engine = {
    name: document.getElementById('eng-name').value,
    type: type,
    enabled: true,
    description: document.getElementById('eng-desc').value
  };
  if (!engine.name) { alert('نام موتور را وارد کنید'); return; }
  if (type === 'clamav') {
    engine.host = document.getElementById('eng-host').value || 'clamav';
    engine.port = parseInt(document.getElementById('eng-port').value) || 3310;
  } else if (type === 'rest_api') {
    engine.url = document.getElementById('eng-url').value;
    engine.api_key = document.getElementById('eng-apikey').value;
    engine.method = 'POST';
    engine.file_field = 'file';
  } else if (type === 'virustotal') {
    engine.api_key = document.getElementById('eng-apikey').value;
  } else if (type === 'yara') {
    engine.rules_path = '/app/rules';
  }

  var result = document.getElementById('engine-result');
  fetch('/api/engines', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(engine)})
    .then(function(r) { return r.json().then(function(d) { return {ok:r.ok, d:d}; }); })
    .then(function(res) {
      result.style.display = 'block';
      result.className = 'result-msg ' + (res.ok?'success':'error');
      result.textContent = res.ok ? 'موتور با موفقیت اضافه شد' : ('خطا: ' + (res.d.detail||res.d.error||''));
      if (res.ok) { loadEngines(); document.getElementById('add-engine-form').style.display = 'none'; }
    }).catch(function() {
      result.style.display = 'block'; result.className = 'result-msg error'; result.textContent = 'خطا در ارتباط';
    });
}

document.getElementById('yara-zip-area').onclick = function() { document.getElementById('yara-zip-file').click(); };
document.getElementById('yara-zip-file').onchange = function() { if (this.files[0]) uploadYaraZip(this.files[0]); };

function uploadYaraZip(file) {
  var prog = document.getElementById('yara-zip-progress');
  var result = document.getElementById('yara-zip-result');
  prog.style.display = 'block'; result.style.display = 'none';
  var fd = new FormData(); fd.append('file', file);
  fetch('/api/update/yara/zip', {method:'POST', body:fd}).then(function(r) {
    return r.json().then(function(d) { return {ok:r.ok, d:d}; });
  }).then(function(res) {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg ' + (res.ok?'success':'error');
    if (res.ok) {
      result.textContent = 'موفق: ' + res.d.added + ' rule اضافه شد' + (res.d.errors > 0 ? ' | ' + res.d.errors + ' خطا' : '');
      loadYaraList();
    } else {
      result.textContent = 'خطا: ' + (res.d.error||'');
    }
  }).catch(function() {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg error'; result.textContent = 'خطا در ارتباط';
  });
}

document.getElementById('yara-zip-area').onclick = function() { document.getElementById('yara-zip-file').click(); };
document.getElementById('yara-zip-file').onchange = function() { if (this.files[0]) uploadYaraZip(this.files[0]); };

function uploadYaraZip(file) {
  var prog = document.getElementById('yara-zip-progress');
  var result = document.getElementById('yara-zip-result');
  prog.style.display = 'block'; result.style.display = 'none';
  var fd = new FormData(); fd.append('file', file);
  fetch('/api/update/yara/zip', {method:'POST', body:fd}).then(function(r) {
    return r.json().then(function(d) { return {ok:r.ok, d:d}; });
  }).then(function(res) {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg ' + (res.ok?'success':'error');
    if (res.ok) {
      result.textContent = 'موفق: ' + res.d.added + ' rule اضافه شد' + (res.d.errors > 0 ? ' | ' + res.d.errors + ' خطا' : '');
      loadYaraList();
    } else {
      result.textContent = 'خطا: ' + (res.d.error||'');
    }
  }).catch(function() {
    prog.style.display = 'none'; result.style.display = 'block';
    result.className = 'result-msg error'; result.textContent = 'خطا در ارتباط';
  });
}
