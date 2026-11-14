'use strict';
const $ = id => document.getElementById(id);
const DEFAULTS = {
  broker: 'wss://broker.emqx.io:8084/mqtt',
  base: 'lab3/runner/thehienx5-20261114',
  project: 'https://wokwi.com/projects/477913990577984513',
  repo: '', autoConnect: true
};
let settings = {...DEFAULTS};
try { settings = {...DEFAULTS, ...JSON.parse(localStorage.getItem('runner-settings-v2') || '{}')}; }
catch (_) { /* Use defaults if storage is unavailable. */ }
let client = null, generation = 0, lastData = 0, lastState = 0;
let state = {}, history = [], pending = null, packetCount = 0;
let brokerOnline = false, linkStatus = 'idle';
const timeText = ms => new Date(ms).toLocaleTimeString('vi-VN');

function log(message) {
  const old = $('log').textContent === 'Chưa có sự kiện.' ? '' : $('log').textContent;
  $('log').textContent = (timeText(Date.now()) + '  ' + message + '\n' + old).slice(0, 18000);
}
function view(name) {
  ['overview', 'mqtt'].forEach(id => $('view-' + id).hidden = id !== name);
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  location.hash = name;
  window.scrollTo(0, 0);
}
function mqttTab(name) {
  ['connection', 'logs', 'settings'].forEach(id => $('mqtt-' + id).hidden = id !== name);
  document.querySelectorAll('[data-mqtt-tab]').forEach(button => {
    const active = button.dataset.mqttTab === name;
    button.classList.toggle('selected', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(b.dataset.view));
document.querySelectorAll('[data-mqtt-tab]').forEach(b => b.onclick = () => mqttTab(b.dataset.mqttTab));
$('mqtt-shortcut').onclick = () => { view('mqtt'); mqttTab('connection'); };
$('open-settings').onclick = () => mqttTab('settings');
document.querySelector('.brand').onclick = event => { event.preventDefault(); view('overview'); };
$('today').textContent = new Date().toLocaleDateString('vi-VN', {day:'2-digit',month:'long',year:'numeric'});

function dot(id, mode) { $(id).className = 'dot' + (mode ? ' ' + mode : ''); }
function connectionStatus(mode) {
  linkStatus = mode;
  brokerOnline = mode === 'online';
  const labels = {
    idle: ['MQTT chưa kết nối', 'Chưa kết nối', 'Chưa mở kết nối tới broker.'],
    connecting: ['MQTT đang kết nối', 'Đang kết nối', 'Đang mở kết nối và đăng ký nhận dữ liệu.'],
    online: ['MQTT đang hoạt động', 'Đã kết nối', 'Web đã kết nối broker. Trạng thái ESP32 được kiểm tra riêng qua dữ liệu mới.'],
    reconnecting: ['MQTT đang kết nối lại', 'Đang kết nối lại', 'Tự thử lại sau mỗi 3 giây khi mất kết nối.'],
    offline: ['MQTT không hoạt động', 'Đã ngắt kết nối', 'Kết nối broker chưa sẵn sàng. Các lệnh điều khiển bị khóa.']
  };
  const [main, title, description] = labels[mode];
  $('network').textContent = main;
  $('mqtt-status').textContent = title;
  $('mqtt-description').textContent = description;
  $('mqtt-shortcut').dataset.state = mode;
  $('mqtt-shortcut').querySelector('.dot').className = 'dot' + (brokerOnline ? ' online' : '');
  dot('nav-dot', brokerOnline ? 'online' : '');
  $('disconnect').disabled = !client;
  refreshAvailability();
}
function refreshAvailability() {
  const freshState = lastState > 0 && Date.now() - lastState < 6000;
  const enabled = brokerOnline && freshState && !pending;
  ['auto', 'led', 'buzzer'].forEach(id => $(id).disabled = !enabled);
  if (!freshState) {
    $('alarm').textContent = lastState ? 'Trạng thái cảnh báo quá hạn' : 'Chờ trạng thái thiết bị';
    $('mode').textContent = 'Chế độ: —';
    $('controls').dataset.alert = 'false';
    $('led-label').textContent = $('buzzer-label').textContent = 'Chưa xác định';
    ['led','buzzer','auto'].forEach(id => $(id).setAttribute('aria-pressed', 'false'));
    $('controls').querySelector('.alarm-icon').textContent = '—';
  }
  if (lastData && Date.now() - lastData >= 6000) {
    deviceStatus('Dữ liệu ESP32 quá hạn', false);
    clearNumbers();
  }
}
function clearNumbers() { ['temperature','pressure','altitude'].forEach(id => $(id).textContent = '—'); }
function deviceStatus(text, online) {
  $('device').textContent = text; $('mqtt-device').textContent = text;
  dot('live-dot', online ? 'online' : 'warning');
  dot('board-dot', online ? 'online' : '');
}
function resetData() {
  lastData = lastState = 0; state = {}; pending = null; packetCount = 0; history = [];
  clearNumbers(); deviceStatus('Đang chờ thiết bị', false);
  $('updated').textContent = 'Chưa có mẫu dữ liệu';
  $('packet-count').textContent = '0'; $('last-packet').textContent = '—';
  $('subscription').textContent = 'Chưa đăng ký';
  $('command').textContent = 'Trạng thái đầu ra được xác nhận từ ESP32.';
  draw('tempChart', 't', '°C'); draw('altChart', 'h', 'm');
}
function connect() {
  const currentGeneration = ++generation;
  if (client) client.end(true);
  client = null; resetData(); connectionStatus('connecting');
  if (typeof mqtt === 'undefined') {
    log('Không tìm thấy mqtt.min.js. Giữ tệp này cùng thư mục HTML.');
    connectionStatus('offline'); return;
  }
  const base = settings.base;
  try {
    client = mqtt.connect(settings.broker, {
      clientId: 'runner-web-' + (crypto.randomUUID ? crypto.randomUUID().slice(0,10) : Math.random().toString(16).slice(2)),
      clean: true, reconnectPeriod: 3000, connectTimeout: 10000, keepalive: 20
    });
  } catch (error) { log('Lỗi kết nối: ' + error.message); connectionStatus('offline'); return; }
  const connection = client;
  const current = () => currentGeneration === generation && connection === client;
  connection.on('connect', () => {
    if (!current()) return;
    connectionStatus('online');
    connection.subscribe([base+'/telemetry', base+'/state', base+'/status'], (error, granted) => {
      if (!current()) return;
      if (error || !granted || granted.some(g => g.qos === 128)) {
        $('subscription').textContent = 'Đăng ký thất bại'; log('SUB thất bại');
      } else { $('subscription').textContent = '3 topic đang theo dõi'; log('SUB ' + base + '/{telemetry,state,status}'); }
    });
  });
  connection.on('reconnect', () => { if (current()) connectionStatus('reconnecting'); });
  connection.on('close', () => {
    if (!current()) return;
    connectionStatus('offline');
    $('subscription').textContent = 'Chờ kết nối lại';
    deviceStatus('Mất kết nối truyền dữ liệu', false); clearNumbers();
  });
  connection.on('error', error => { if (current()) log('MQTT: ' + error.message); });
  connection.on('message', (topic, payload) => {
    if (!current()) return;
    const text = payload.toString();
    $('packet-count').textContent = String(++packetCount);
    $('last-packet').textContent = timeText(Date.now());
    log('RX ' + topic.split('/').pop() + ' ' + text);
    if (topic === base+'/status') {
      // Retained status may be old. Fresh telemetry, not retained online, is authoritative.
      if (text === 'offline' && (!lastData || Date.now()-lastData >= 6000)) deviceStatus('ESP32 không hoạt động', false);
      return;
    }
    let d;
    try { d = JSON.parse(text); } catch (_) { log('Bỏ qua JSON không hợp lệ'); return; }
    if (!d || typeof d !== 'object') return;
    if (topic === base+'/telemetry') {
      if (typeof d.valid !== 'boolean' || !Number.isFinite(d.seq) || !Number.isFinite(d.ms)) return;
      lastData = Date.now();
      $('updated').textContent = 'Mẫu #' + d.seq + ' · Thiết bị chạy ' + (d.ms/1000).toFixed(0) + ' s';
      const valid = d.valid && ['temperature','pressure','altitude'].every(key => Number.isFinite(d[key]));
      ['temperature','pressure','altitude'].forEach(key => $(key).textContent = valid ? d[key].toFixed(2) : '—');
      deviceStatus(valid ? 'Thiết bị đang gửi dữ liệu' : 'Lỗi dữ liệu cảm biến', valid);
      if (valid) {
        history.push({time:Date.now(),t:d.temperature,h:d.altitude}); history = history.slice(-90);
        draw('tempChart','t','°C'); draw('altChart','h','m');
      }
    } else if (topic === base+'/state') {
      if (!['auto','manual'].includes(d.mode) || !['led','buzzer','tempAlarm','altitudeAlarm','sensorFault'].every(k => typeof d[k] === 'boolean')) return;
      state = d; lastState = Date.now();
      $('mode').textContent = 'Chế độ: ' + d.mode.toUpperCase();
      $('led-label').textContent = d.led ? 'Đang bật' : 'Đang tắt';
      $('buzzer-label').textContent = d.buzzer ? 'Đang bật' : 'Đang tắt';
      $('led').setAttribute('aria-pressed', String(d.led));
      $('buzzer').setAttribute('aria-pressed', String(d.buzzer));
      $('auto').setAttribute('aria-pressed', String(d.mode === 'auto'));
      const alerts = [];
      if (d.tempAlarm) alerts.push('Nhiệt độ vượt ngưỡng');
      if (d.altitudeAlarm) alerts.push('Độ cao thay đổi đột ngột');
      if (d.sensorFault) alerts.push('Lỗi hoặc mất cảm biến');
      $('alarm').textContent = alerts.length ? alerts.join(' · ') : 'Mọi chỉ số trong phạm vi theo dõi';
      $('controls').dataset.alert = String(alerts.length > 0);
      $('controls').querySelector('.alarm-icon').textContent = alerts.length ? '!' : '✓';
      if (pending && confirmed(d, pending.value)) {
        $('command').textContent = 'ESP32 đã xác nhận ' + pending.value; pending = null;
      }
      refreshAvailability();
    }
  });
}
function confirmed(s, c) {
  if (c === 'MODE_AUTO') return s.mode === 'auto';
  return s.mode === 'manual' && (c.startsWith('LED_') ? s.led === (c==='LED_ON') : s.buzzer === (c==='BUZZER_ON'));
}
function command(value) {
  if (!brokerOnline || !lastState || Date.now()-lastState >= 6000 || pending) return;
  pending = {value, time:Date.now()}; refreshAvailability();
  client.publish(settings.base+'/cmd', value, {qos:0,retain:false});
  $('command').textContent = 'Đã gửi ' + value + ' · Chờ ESP32 xác nhận'; log('TX ' + value);
}
$('connect').onclick = connect;
$('disconnect').onclick = () => {
  generation++; if (client) client.end(true); client = null;
  resetData(); connectionStatus('offline'); log('Đã ngắt kết nối theo yêu cầu.');
};
$('auto').onclick = () => command('MODE_AUTO');
$('led').onclick = () => command(state.led ? 'LED_OFF' : 'LED_ON');
$('buzzer').onclick = () => command(state.buzzer ? 'BUZZER_OFF' : 'BUZZER_ON');
$('clear-log').onclick = () => $('log').textContent = 'Chưa có sự kiện.';

function safeLink(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['https:','http:'].includes(url.protocol)) throw new Error('Đường dẫn bài phải bắt đầu bằng https:// hoặc http://.');
  return url.href;
}
function populateSettings() {
  $('broker').value = settings.broker; $('base').value = settings.base;
  $('project-url').value = settings.project; $('repo-url').value = settings.repo;
  $('auto-connect').checked = settings.autoConnect;
  for (const [id, value] of [['project-link',settings.project],['repo-link',settings.repo]]) {
    try { const link = safeLink(value); $(id).hidden = !link; if (link) $(id).href = link; }
    catch (_) { $(id).hidden = true; }
  }
}
$('settings-form').onsubmit = event => {
  event.preventDefault();
  try {
    const broker = new URL($('broker').value.trim());
    if (!['ws:','wss:'].includes(broker.protocol)) throw new Error('Broker phải dùng ws:// hoặc wss://.');
    if (location.protocol === 'https:' && broker.protocol !== 'wss:') throw new Error('Trang HTTPS cần kết nối wss://.');
    const base = $('base').value.trim().replace(/\/+$/,'');
    if (!base || /[+#\s]/.test(base)) throw new Error('Topic gốc không được rỗng hoặc chứa khoảng trắng, +, #.');
    settings = {broker:broker.href,base,project:safeLink($('project-url').value.trim()),repo:safeLink($('repo-url').value.trim()),autoConnect:$('auto-connect').checked};
    let saved = true;
    try { localStorage.setItem('runner-settings-v2', JSON.stringify(settings)); } catch (_) { saved = false; }
    populateSettings(); connect();
    $('settings-message').textContent = saved ? 'Đã lưu · Đang áp dụng kết nối' : 'Đã áp dụng · Trình duyệt không cho lưu cài đặt';
  } catch (error) { $('settings-message').textContent = error.message; }
};
$('reset-settings').onclick = () => {
  settings = {...DEFAULTS}; populateSettings();
  try { localStorage.setItem('runner-settings-v2', JSON.stringify(settings)); } catch (_) {}
  connect(); $('settings-message').textContent = 'Đã khôi phục và áp dụng mặc định.';
};

function draw(id, key, unit) {
  const c = $(id), ctx = c.getContext('2d'), w = c.width, h = c.height;
  const color = key === 't' ? '#ff8954' : '#c2e976';
  ctx.clearRect(0,0,w,h); ctx.font = '17px Segoe UI, Arial'; ctx.fillStyle = '#8da1b5';
  if (!history.length) { ctx.textAlign='center'; ctx.fillText('Chờ dữ liệu từ ESP32',w/2,h/2); ctx.textAlign='start'; return; }
  const vals=history.map(d=>d[key]); const pad=Math.max((Math.max(...vals)-Math.min(...vals))*.18, .5);
  const min=Math.min(...vals)-pad, max=Math.max(...vals)+pad;
  const left=68,right=w-15,top=18,bottom=h-47;
  ctx.lineWidth=1; ctx.strokeStyle='#2b3642';
  for(let i=0;i<4;i++) {
    const y=top+i*(bottom-top)/3;
    ctx.setLineDash([3,7]); ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.setLineDash([]);
    const n=max-(max-min)*i/3;
    ctx.fillText((Math.abs(n)<.05?0:n).toFixed(1),2,y+5);
  }
  const first=history[0].time,last=history.at(-1).time;
  const points=history.map(d=>[left+(d.time-first)/Math.max(last-first,1)*(right-left),top+(max-d[key])/(max-min)*(bottom-top)]);
  const gradient=ctx.createLinearGradient(0,top,0,bottom);gradient.addColorStop(0,color+'2b');gradient.addColorStop(1,color+'00');
  ctx.beginPath();ctx.moveTo(points[0][0],bottom);points.forEach(p=>ctx.lineTo(...p));ctx.lineTo(points.at(-1)[0],bottom);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
  ctx.strokeStyle=color;ctx.lineWidth=3;ctx.lineJoin='round';ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(...points.at(-1),5,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#8da1b5';ctx.font='15px Segoe UI, Arial';ctx.fillText(timeText(first),left,h-9);ctx.textAlign='right';ctx.fillText(timeText(last),right,h-9);ctx.textAlign='start';
}
setInterval(() => {
  refreshAvailability();
  if(pending && Date.now()-pending.time>5000) {
    $('command').textContent='Chưa có xác nhận ESP32 sau 5 giây';pending=null;refreshAvailability();
  }
},1000);
populateSettings();resetData();connectionStatus('idle');
view(location.hash === '#mqtt' ? 'mqtt' : 'overview');
if(settings.autoConnect) connect();
