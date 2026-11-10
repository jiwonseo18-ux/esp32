'use strict';
const labels = {quiet:'조용', normal:'보통', loud:'시끄러움'};
const STALE_MS = 2 * 60 * 1000;
const demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
const localPreview = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
// The local demo reads live sound data without a local database.
const apiOrigin = demoMode && localPreview ? 'https://esp32-miqj.onrender.com' : '';
const demoReadings = {temperature:23.8, humidity:46};
const theme = getComputedStyle(document.documentElement);
const chartColors = {
  line: theme.getPropertyValue('--accent').trim(),
  fill: theme.getPropertyValue('--chart-fill').trim(),
  grid: theme.getPropertyValue('--line').trim(),
  text: theme.getPropertyValue('--text').trim(),
  muted: theme.getPropertyValue('--muted').trim()
};
let chart;
let selected;
let historyVersion = 0;
const $ = selector => document.querySelector(selector);
const fmtTime = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('ko-KR', {
    timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'
  }).format(date);
};
const fmtReading = (value, unit) => Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : '—';
function fmtEnvironment(item, field, unit) {
  const value = item[field];
  if (demoMode && item.location_id === 'library' && !Number.isFinite(value)) {
    return `${fmtReading(demoReadings[field], unit)} (시연 예시)`;
  }
  return fmtReading(value, unit);
}
const fresh = item => {
  const age = Date.now() - Date.parse(item.recorded_at);
  return Number.isFinite(age) && age >= -60000 && age <= STALE_MS;
};
async function getJSON(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${apiOrigin}${path}`, {signal:controller.signal,cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function markSelected() {
  document.querySelectorAll('.location').forEach(button => {
    const active = button.dataset.id === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
function renderLocations(items) {
  const list = $('#location-list');
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '아직 수신된 소음 데이터가 없습니다.';
    list.append(empty);
    return;
  }
  items.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `location${fresh(item) ? '' : ' stale'}`;
    button.dataset.id = item.location_id;
    const dot = document.createElement('span');
    dot.className = `dot ${Object.hasOwn(labels,item.status) ? item.status : 'normal'}`;
    const detail = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = item.location_name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${labels[item.status] || '-'} · ${fmtTime(item.recorded_at)}${fresh(item) ? '' : ' · 수신 지연'}`;
    const environment = document.createElement('span');
    environment.className = 'meta';
    environment.textContent = `온도 ${fmtEnvironment(item, 'temperature', ' °C')} · 습도 ${fmtEnvironment(item, 'humidity', '%')}`;
    detail.append(name,meta,environment);
    const db = document.createElement('span'); db.className = 'db';
    db.textContent = `${Number(item.db).toFixed(1)} `;
    const unit = document.createElement('small'); unit.textContent = 'dB'; db.append(unit);
    button.append(dot,detail,db);
    button.onclick = () => {
      selected = item.location_id; markSelected();
      void loadHistory(item.location_id,item.location_name);
    };
    list.append(button);
  });
  markSelected();
}
async function loadHistory(id,name) {
  const version = ++historyVersion;
  $('#chart-title').textContent = `${name} 시간대별 소음`;
  $('#chart-message').textContent = '기록을 불러오는 중…';
  if (chart && chart.locationId !== id) { chart.destroy(); chart = null; }
  try {
    const rows = await getJSON(`/api/history/${encodeURIComponent(id)}?hours=12`);
    if (version !== historyVersion || id !== selected) return;
    if (typeof Chart === 'undefined') throw new Error('CHART_UNAVAILABLE');
    const data = {labels:rows.map(r=>fmtTime(r.recorded_at)),datasets:[{
      label:'소음 (dB)',data:rows.map(r=>r.db),borderColor:chartColors.line,
      backgroundColor:chartColors.fill,fill:true,tension:.2,pointRadius:rows.length>100 ? 0 : 2
    }]};
    if (chart) {chart.data=data; chart.update('none');}
    else {
      chart = new Chart($('#noise-chart'),{type:'line',data,options:{
        responsive:true,maintainAspectRatio:false,animation:false,
        scales:{y:{suggestedMin:30,suggestedMax:80,grid:{color:chartColors.grid},ticks:{color:chartColors.muted}},
          x:{grid:{display:false},ticks:{color:chartColors.muted,maxTicksLimit:8}}},
        plugins:{legend:{labels:{color:chartColors.text}}}
      }});
      chart.locationId = id;
    }
    $('#chart-message').textContent = rows.length ? '' : '최근 12시간 기록이 없습니다.';
  } catch(error) {
    if (version !== historyVersion || id !== selected) return;
    $('#chart-message').textContent = error.message === 'CHART_UNAVAILABLE'
      ? '그래프 라이브러리를 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.'
      : '기록 조회 실패. 잠시 후 다시 시도합니다.';
  }
}
async function refresh() {
  try {
    const items = await getJSON('/api/locations');
    if (!items.some(item=>item.location_id===selected)) {
      const defaultLocation = (demoMode && items.find(fresh)) || items[0];
      selected = defaultLocation?.location_id;
    }
    renderLocations(items);
    $('#updated').textContent = `갱신 ${fmtTime(new Date())}`;
    // Derive recommendation from fresh readings, excluding old disconnected sensors.
    const recent = items.filter(fresh);
    const best = recent.reduce((a,b)=>!a || b.db<a.db ? b:a,null);
    $('#recommend').textContent = best
      ? `📍 ${best.location_name} — 최근 수신된 공간 중 가장 조용합니다 (${Number(best.db).toFixed(1)} dB).`
      : items.length ? '최근 2분 이내 수신된 데이터가 없습니다. 센서 연결을 확인해 주세요.'
      : '추천을 위해 소음 측정 데이터를 기다리고 있습니다.';
    const current = items.find(item=>item.location_id===selected);
    if (current) await loadHistory(current.location_id,current.location_name);
    else {
      ++historyVersion;
      if (chart) {chart.destroy();chart=null;}
      $('#chart-title').textContent = '시간대별 소음';
      $('#chart-message').textContent = '측정 데이터를 기다리고 있습니다.';
    }
  } catch(error) {
    $('#updated').textContent = '연결 재시도 중';
    $('#recommend').textContent = '서버에 연결하지 못했습니다. 표시된 값은 마지막 조회 결과이며 자동으로 재시도합니다.';
  } finally {setTimeout(refresh,2500);}
}
void refresh();
