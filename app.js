'use strict';

/* ============================== Definiciones (tabla 1 del SPEC) ============================== */

const RECORD_DEFS = [
  { key: 'bhuj78',  label: 'Bhuj 78',  eq: 'BHUJ', comp: '78',  N: 26706, dt: 0.005, peakCm: 104, g: 9.80665,  lengthUnit: 'm',  accelUnit: 'm/s²' },
  { key: 'bhuj348', label: 'Bhuj 348', eq: 'BHUJ', comp: '348', N: 26706, dt: 0.005, peakCm: 78,  g: 9.80665,  lengthUnit: 'm',  accelUnit: 'm/s²' },
  { key: 'bhujUP',  label: 'Bhuj UP',  eq: 'BHUJ', comp: 'UP',  N: 26706, dt: 0.005, peakCm: 69,  g: 9.80665,  lengthUnit: 'm',  accelUnit: 'm/s²' },
  { key: 'valp290', label: 'Valp 290', eq: 'VALP', comp: '290', N: 9733,  dt: 0.005, peakCm: 174, g: 980.665, lengthUnit: 'cm', accelUnit: 'cm/s²' },
  { key: 'valp200', label: 'Valp 200', eq: 'VALP', comp: '200', N: 9729,  dt: 0.005, peakCm: 131, g: 980.665, lengthUnit: 'cm', accelUnit: 'cm/s²' },
];

const RESP_META = [
  { key: 'x',   label: 'Desplazamiento relativo (x)',              unit: 'len'  },
  { key: 'v',   label: 'Velocidad relativa (v)',                    unit: 'len/s' },
  { key: 'Sv',  label: 'Pseudo velocidad (Sv)',                      unit: 'len/s' },
  { key: 'h',   label: 'Aceleración relativa (h)',                   unit: 'len/s²' },
  { key: 'I',   label: 'Aceleración absoluta (I)',                   unit: 'len/s²' },
  { key: 'J',   label: 'Aceleración normalizada (J = I/g)',          unit: 'adim' },
  { key: 'Sa',  label: 'Pseudo aceleración (Sa)',                    unit: 'len/s²' },
  { key: 'SaN', label: 'Pseudo aceleración normalizada (SaN = Sa/g)', unit: 'adim' },
];

const XI = [0.00, 0.02, 0.05, 0.10, 0.20];
const XI_KEYS = ['xi0', 'xi2', 'xi5', 'xi10', 'xi20'];
const XI_COLORS = ['#4fd1ff', '#34d399', '#eab308', '#f5677a', '#b58af0'];
const MEAN_COLOR = '#f4f1e8';

// T_GRID: 0.001, luego 0.01..10.00 en pasos de 0.01 (1001 valores)
const TGrid = [0.001];
for (let n = 1; n <= 1000; n++) TGrid.push(n / 100); // 0.01, 0.02, ..., 10.00
const TGridArr = Float64Array.from(TGrid);

/* ============================== Valores de referencia — sección 7 ============================== */

const REF_CHECK1 = {
  bhuj78:  { x: 0.046917, v: 0.288242, Sv: 0.294785, h: 2.093136, I: 1.862003, J: 0.189871, Sa: 1.852191, SaN: 0.188871 },
  bhuj348: { x: 0.021413, v: 0.144503, Sv: 0.134542, h: 1.339221, I: 0.851805, J: 0.086860, Sa: 0.845351, SaN: 0.086202 },
  bhujUP:  { x: 0.007002, v: 0.052628, Sv: 0.043997, h: 0.855305, I: 0.278763, J: 0.028426, Sa: 0.276439, SaN: 0.028189 },
  valp290: { x: 1.972581, v: 14.458246, Sv: 12.394094, h: 214.234500, I: 78.557287, J: 0.080106, Sa: 77.874388, SaN: 0.079410 },
  valp200: { x: 2.209438, v: 15.202834, Sv: 13.882306, h: 144.098159, I: 87.909934, J: 0.089643, Sa: 87.225102, SaN: 0.088945 },
};

const REF_CHECK2 = {
  bhuj78:  { max: 0.402549, T: 0.26 },
  bhuj348: { max: 0.238699, T: 0.29 },
  bhujUP:  { max: 0.246859, T: 0.24 },
  valp290: { max: 0.587278, T: 0.28 },
  valp200: { max: 0.491934, T: 0.32 },
};

const REF_CHECK3 = { bhuj78: 0.1061, bhuj348: 0.0795, bhujUP: 0.0704, valp290: 0.1775, valp200: 0.1336 };

/* ============================== Estado ============================== */

const records = {};      // key -> { def, filename, N, dt, peakNative, peakCm, agFull }
const sweepCache = {};   // key -> { results: [xi0..xi4] each {resp:Float64Array}, mean: {resp:Float64Array} }
let step7Passed = false;
let worker = null;
let currentComputingKey = null;

/* ============================== Parsing ============================== */

function detectEqAndComp(filename, text) {
  let eq = null;
  if (/bhuj/i.test(filename) || /bhuj/i.test(text)) eq = 'BHUJ';
  else if (/chile|laligua/i.test(filename) || /chile|laligua/i.test(text)) eq = 'VALP';

  let comp = null;
  // Separador flexible tras "componente": espacio, guion, guion bajo o paréntesis
  // ("Componente_UP", "Componente-UP", "Componente UP", "Componente(UP)"...),
  // para no depender de cómo el usuario haya renombrado el archivo.
  let m = /componente[\s_()-]+([A-Za-z0-9]+)/i.exec(filename);
  if (m) comp = m[1].toUpperCase();
  if (!comp) {
    m = /(\d{1,3})\s*DEGREES/i.exec(text);
    if (m) comp = m[1];
  }
  if (!comp) {
    m = /COMPONENT\s*=\s*([A-Za-z0-9]+)/i.exec(text);
    if (m) comp = m[1].toUpperCase();
  }
  // Respaldo final: leer el componente directamente del encabezado del
  // registro Bhuj ("Comp: N 78 E" / "Comp: N 12 W" / "Comp:Vertical"), sin
  // depender en absoluto del nombre del archivo.
  if (!comp && eq === 'BHUJ') {
    if (/Comp\s*:\s*Vertical/i.test(text)) {
      comp = 'UP';
    } else {
      m = /Comp\s*:\s*N\s*(\d{1,3})\s*E/i.exec(text);
      if (m) comp = m[1];
      else {
        m = /Comp\s*:\s*N\s*(\d{1,3})\s*W/i.exec(text);
        if (m) comp = String(360 - parseInt(m[1], 10));
      }
    }
  }
  return { eq, comp };
}

function findDef(eq, comp) {
  if (!eq || !comp) return null;
  return RECORD_DEFS.find((d) => d.eq === eq && d.comp === String(comp).toUpperCase()) || null;
}

function extractHeaderInfo(text) {
  // dataStart ancla el inicio de los datos justo después de la línea de cabecera
  // que declara el conteo de puntos — funciona igual con el .txt crudo tal como
  // lo entrega CESMD (sin envoltorio) y con una versión markdown/fenced del
  // mismo archivo, porque no depende de ver un bloque ```texto```.
  let m = /(\d+)\s+Acceleration data points\s*\(in\s*([^)]+)\)\s*at\s*([\d.]+)\s*sec/i.exec(text);
  if (m) return { format: 'bhuj', N: parseInt(m[1], 10), dt: parseFloat(m[3]), dataStart: m.index + m[0].length };

  const mN = /NO OF POINTS\s*=\s*(\d+)/i.exec(text);
  const mRate = /SAMPLES\/SEC\s*=\s*([\d.]+)/i.exec(text);
  if (mN && mRate) return { format: 'valp', N: parseInt(mN[1], 10), dt: 1 / parseFloat(mRate[1]), dataStart: mN.index + mN[0].length };

  return null;
}

function extractAccelData(text, N, startIndex) {
  let i = startIndex || 0;
  const len = text.length;
  const numRe = /^[+-]?(\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
  const ag = new Float64Array(N);
  let count = 0;
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

  while (count < N && i < len) {
    while (i < len && isSpace(text[i])) i++;
    let j = i;
    while (j < len && !isSpace(text[j])) j++;
    if (j > i) {
      const tok = text.slice(i, j);
      if (numRe.test(tok)) ag[count++] = parseFloat(tok);
    }
    i = j;
  }
  if (count < N) throw new Error(`Solo se pudieron leer ${count} de ${N} puntos esperados.`);
  return ag;
}

function buildAgFull(agData, N) {
  const full = new Float64Array(N + 2);
  full.set(agData, 1);
  full[0] = 0;
  full[N + 1] = 0;
  return full;
}

function parseRecordFile(filename, text) {
  const { eq, comp } = detectEqAndComp(filename, text);
  const def = findDef(eq, comp);
  if (!def) throw new Error(`No se pudo identificar el registro a partir de "${filename}" (sismo=${eq || '?'}, comp=${comp || '?'}).`);

  const header = extractHeaderInfo(text);
  if (!header) throw new Error(`No se pudo leer la cabecera de "${filename}" (formato no reconocido).`);

  const agData = extractAccelData(text, header.N, header.dataStart);
  let peakNative = 0;
  for (let k = 0; k < agData.length; k++) {
    const a = Math.abs(agData[k]);
    if (a > peakNative) peakNative = a;
  }
  const peakCm = def.lengthUnit === 'm' ? peakNative * 100 : peakNative;
  const agFull = buildAgFull(agData, header.N);

  return { def, filename, N: header.N, dt: header.dt, peakNative, peakCm, agFull };
}

/* ============================== Banner de error ============================== */

const errorBanner = document.getElementById('errorBanner');
const errorBannerText = document.getElementById('errorBannerText');
const errorBannerClose = document.getElementById('errorBannerClose');
let errorHideTimer = null;

function showError(message) {
  errorBannerText.textContent = message;
  errorBanner.hidden = false;
  clearTimeout(errorHideTimer);
  errorHideTimer = setTimeout(hideError, 9000);
}
function hideError() {
  errorBanner.hidden = true;
  clearTimeout(errorHideTimer);
}
errorBannerClose.addEventListener('click', hideError);

/* ============================== UI: carga de archivos ============================== */

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const validationBody = document.getElementById('validationBody');
const step1Toggle = document.getElementById('step1Toggle');
const step1Content = document.getElementById('step1Content');
const step1Badge = document.getElementById('step1Badge');
const step1State = document.getElementById('step1State');
const step2Toggle = document.getElementById('step2Toggle');
const step2Content = document.getElementById('step2Content');
const step2Badge = document.getElementById('step2Badge');
const step3Badge = document.getElementById('step3Badge');

function setStepCollapsed(li, toggleBtn, contentEl, collapsed) {
  toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  if (collapsed) li.setAttribute('data-collapsed', ''); else li.removeAttribute('data-collapsed');
}
function bindStepToggle(li, toggleBtn, contentEl) {
  toggleBtn.addEventListener('click', () => {
    const collapsed = toggleBtn.getAttribute('aria-expanded') === 'true';
    setStepCollapsed(li, toggleBtn, contentEl, collapsed);
  });
}
bindStepToggle(document.getElementById('step1'), step1Toggle, step1Content);
bindStepToggle(document.getElementById('step2'), step2Toggle, step2Content);

let autoCollapsedOnce = false;

function renderValidationTable() {
  validationBody.innerHTML = '';
  for (const def of RECORD_DEFS) {
    const rec = records[def.key];
    const tr = document.createElement('tr');

    const tdLabel = document.createElement('td');
    tdLabel.textContent = def.label;
    tr.appendChild(tdLabel);

    const tdFile = document.createElement('td');
    tdFile.style.textAlign = 'left';
    tdFile.textContent = rec ? rec.filename : '—';
    tr.appendChild(tdFile);

    const tdPts = document.createElement('td');
    tdPts.className = 'num';
    const tdPeak = document.createElement('td');
    tdPeak.className = 'num';
    const tdStatus = document.createElement('td');

    if (rec) {
      const pointsOk = rec.N === def.N;
      const peakOk = Math.abs(rec.peakCm - def.peakCm) <= 1;
      tdPts.textContent = `${rec.N} / ${def.N}`;
      tdPeak.textContent = `${rec.peakCm.toFixed(2)} / ${def.peakCm}`;
      const ok = pointsOk && peakOk;
      const span = document.createElement('span');
      span.className = 'tag ' + (ok ? 'ok' : 'bad');
      span.textContent = ok ? 'OK' : 'FALLA';
      tdStatus.appendChild(span);
      rec.valid = ok;
    } else {
      tdPts.textContent = `— / ${def.N}`;
      tdPeak.textContent = `— / ${def.peakCm}`;
      const span = document.createElement('span');
      span.className = 'tag pending';
      span.textContent = 'Falta';
      tdStatus.appendChild(span);
    }

    tr.appendChild(tdPts);
    tr.appendChild(tdPeak);
    tr.appendChild(tdStatus);
    validationBody.appendChild(tr);
  }

  const loaded = RECORD_DEFS.filter((d) => records[d.key]).length;
  const valid = RECORD_DEFS.filter((d) => records[d.key] && records[d.key].valid).length;
  const anyInvalid = RECORD_DEFS.some((d) => records[d.key] && !records[d.key].valid);

  if (valid === RECORD_DEFS.length) {
    step1Badge.dataset.state = 'done';
    step1Badge.textContent = '✓';
    step1State.textContent = `5 / 5 registros validados`;
    step1State.dataset.state = 'ok';
  } else if (anyInvalid) {
    step1Badge.dataset.state = 'error';
    step1Badge.textContent = '!';
    step1State.textContent = `${valid} / 5 válidos — revisa los marcados en rojo`;
    step1State.dataset.state = 'bad';
  } else if (loaded > 0) {
    step1Badge.dataset.state = 'active';
    step1Badge.textContent = String(loaded);
    step1State.textContent = `${loaded} / 5 cargados`;
    step1State.dataset.state = '';
  } else {
    step1Badge.dataset.state = '';
    step1Badge.textContent = '1';
    step1State.textContent = 'Esperando archivos…';
    step1State.dataset.state = '';
  }
}
renderValidationTable();

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    try {
      const text = await file.text();
      const rec = parseRecordFile(file.name, text);
      records[rec.def.key] = rec;
    } catch (err) {
      console.error('Error procesando', file.name, err);
      showError(`Error al procesar "${file.name}": ${err.message}`);
    }
  }
  renderValidationTable();
  maybeRunStep7();
}
window.handleFiles = handleFiles; // expuesto para pruebas automatizadas

fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  handleFiles(e.dataTransfer.files);
});

/* ============================== Paso 2: verificación sección 7 ============================== */

const step7Banner = document.getElementById('step7Banner');
const step7Tables = document.getElementById('step7Tables');
const check1Body = document.getElementById('check1Body');
const check2Body = document.getElementById('check2Body');
const check3Body = document.getElementById('check3Body');
const check4Body = document.getElementById('check4Body');
const plotSection = document.getElementById('plotSection');

function allFilesValid() {
  return RECORD_DEFS.every((def) => records[def.key] && records[def.key].valid);
}

function maybeRunStep7() {
  if (!allFilesValid()) {
    step7Passed = false;
    step7Banner.dataset.state = '';
    step7Banner.textContent = 'Esperando los 5 registros validados…';
    step7Tables.hidden = true;
    step2Badge.dataset.state = '';
    step2Badge.textContent = '2';
    plotSection.classList.add('locked');
    return;
  }
  step7Banner.dataset.state = '';
  step7Banner.textContent = 'Verificando contra la sección 7 del SPEC…';
  step2Badge.dataset.state = 'active';
  step2Badge.textContent = '2';
  setTimeout(runStep7, 30);
}

const RESP_KEYS = ['x', 'v', 'Sv', 'h', 'I', 'J', 'Sa', 'SaN'];

function runStep7() {
  let allOk = true;

  // Chequeo 1: T=1.00 s, xi=0.05
  check1Body.innerHTML = '';
  for (const def of RECORD_DEFS) {
    const rec = records[def.key];
    const ref = REF_CHECK1[def.key];
    const out = computeOne(rec.agFull, def.dt, def.g, 1.0, 0.05);

    let maxRel = 0;
    for (const r of RESP_KEYS) {
      const rel = Math.abs(out[r] - ref[r]) / Math.max(Math.abs(ref[r]), 1e-9);
      if (rel > maxRel) maxRel = rel;
    }
    const ok = maxRel < 1e-4;
    if (!ok) allOk = false;

    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${def.label}</td>` +
      RESP_KEYS.map((r) => `<td class="num">${out[r].toFixed(6)}</td>`).join('') +
      `<td class="num"><span class="tag ${ok ? 'ok' : 'bad'}">${(maxRel * 100).toFixed(4)}%</span></td>`;
    check1Body.appendChild(tr);
  }

  // Chequeo 2: pico de SaN (xi=0.05) sobre todo T_GRID
  check2Body.innerHTML = '';
  for (const def of RECORD_DEFS) {
    const rec = records[def.key];
    let maxSaN = -Infinity, atT = null;
    for (let ti = 0; ti < TGrid.length; ti++) {
      const out = computeOne(rec.agFull, def.dt, def.g, TGrid[ti], 0.05);
      if (out.SaN > maxSaN) { maxSaN = out.SaN; atT = TGrid[ti]; }
    }
    const ref = REF_CHECK2[def.key];
    const okVal = Math.abs(maxSaN - ref.max) / ref.max < 1e-3;
    const okT = Math.abs(atT - ref.T) <= 0.02;
    const ok = okVal && okT;
    if (!ok) allOk = false;

    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${def.label}</td><td class="num">${maxSaN.toFixed(6)}</td><td class="num">${ref.max.toFixed(6)}</td>` +
      `<td class="num">${atT.toFixed(2)}</td><td class="num">${ref.T.toFixed(2)}</td>` +
      `<td><span class="tag ${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'FALLA'}</span></td>`;
    check2Body.appendChild(tr);
  }

  // Chequeo 3: J en T=0.001 s, xi=0.05 ~ PGA/g
  check3Body.innerHTML = '';
  for (const def of RECORD_DEFS) {
    const rec = records[def.key];
    const out = computeOne(rec.agFull, def.dt, def.g, 0.001, 0.05);
    const ref = REF_CHECK3[def.key];
    const ok = Math.abs(out.J - ref) < 5e-3;
    if (!ok) allOk = false;

    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${def.label}</td><td class="num">${out.J.toFixed(6)}</td><td class="num">${ref.toFixed(4)}</td>` +
      `<td><span class="tag ${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'FALLA'}</span></td>`;
    check3Body.appendChild(tr);
  }

  // Chequeo 4: Chopra vs. integración directa (deben coincidir a precisión de máquina)
  check4Body.innerHTML = '';
  for (const def of RECORD_DEFS) {
    const rec = records[def.key];
    const a = computeOne(rec.agFull, def.dt, def.g, 1.0, 0.05);
    const b = computeOneDirect(rec.agFull, def.dt, def.g, 1.0, 0.05);
    const rel = Math.abs(a.x - b.x) / Math.max(Math.abs(a.x), 1e-9);
    const ok = rel < 1e-8;

    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${def.label}</td><td class="num">${a.x.toFixed(8)}</td><td class="num">${b.x.toFixed(8)}</td>` +
      `<td class="num">${rel.toExponential(2)}</td>` +
      `<td><span class="tag ${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'FALLA'}</span></td>`;
    check4Body.appendChild(tr);
  }

  step7Tables.hidden = false;
  step7Passed = allOk;
  if (allOk) {
    step7Banner.dataset.state = 'ok';
    step7Banner.textContent = '✓ Coincide con la sección 7 del SPEC — barrido habilitado';
    step2Badge.dataset.state = 'done';
    step2Badge.textContent = '✓';
    step3Badge.dataset.state = 'active';
    plotSection.classList.remove('locked');
    initPlotSection();

    if (!autoCollapsedOnce) {
      autoCollapsedOnce = true;
      setStepCollapsed(document.getElementById('step1'), step1Toggle, step1Content, true);
      setStepCollapsed(document.getElementById('step2'), step2Toggle, step2Content, true);
    }
  } else {
    step7Banner.dataset.state = 'bad';
    step7Banner.textContent = '✗ No coincide con la sección 7 — revisa las tablas debajo';
    step2Badge.dataset.state = 'error';
    step2Badge.textContent = '!';
    step3Badge.dataset.state = '';
    plotSection.classList.add('locked');
  }
}
window.__getStep7State = () => ({ step7Passed });

/* ============================== Paso 3: barrido completo + gráfico ============================== */

const registroSelect = document.getElementById('registroSelect');
const respuestaSelect = document.getElementById('respuestaSelect');
const methodSelect = document.getElementById('methodSelect');
const progressWrap = document.getElementById('progressWrap');

function cacheKey(key, method) { return `${key}::${method}`; }
const progressBarInner = document.getElementById('progressBarInner');
const progressText = document.getElementById('progressText');
const chartCanvas = document.getElementById('chartCanvas');
const chartOverlay = document.getElementById('chartOverlay');
const chartWrap = chartCanvas.parentElement;
const chartTooltip = document.getElementById('chartTooltip');
const legendEl = document.getElementById('legend');

const hiddenSeriesKeys = new Set(); // series ocultadas por clic en la leyenda (persiste entre cambios)

function initPlotSection() {
  if (registroSelect.options.length) return; // ya inicializado
  for (const def of RECORD_DEFS) {
    const opt = document.createElement('option');
    opt.value = def.key;
    opt.textContent = def.label;
    registroSelect.appendChild(opt);
  }
  for (const meta of RESP_META) {
    const opt = document.createElement('option');
    opt.value = meta.key;
    opt.textContent = meta.label;
    respuestaSelect.appendChild(opt);
  }
  registroSelect.addEventListener('change', onRegistroChange);
  respuestaSelect.addEventListener('change', drawCurrentChart);
  methodSelect.addEventListener('change', onMethodChange);
  onRegistroChange();
}

function onMethodChange() {
  const key = registroSelect.value;
  const method = methodSelect.value;
  hideTooltip(chartOverlay, chartTooltip);
  const ck = cacheKey(key, method);
  if (sweepCache[ck]) {
    drawCurrentChart();
  } else {
    ensureSweep(key);
    clearChart();
  }
}

let workerAvailable = null; // null = aún no se sabe, true = confirmado, false = usar respaldo en hilo principal

function getWorker() {
  if (!worker) {
    worker = new Worker('worker.js');
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        workerAvailable = true;
        const pct = Math.round(msg.pct * 100);
        progressBarInner.style.transform = `scaleX(${msg.pct})`;
        progressText.textContent = `Calculando… ${pct}%`;
      } else if (msg.type === 'done') {
        workerAvailable = true;
        storeSweepResult(msg.key, msg.results, msg.mean);
      }
    };
    worker.onerror = (err) => {
      console.warn('Web Worker falló (posiblemente bloqueado por el navegador bajo file://); usando cálculo en el hilo principal.', err.message);
      workerAvailable = false;
      worker = null;
      const ck = currentComputingKey;
      if (ck && !sweepCache[ck]) {
        currentComputingKey = null;
        ensureSweep(ck.split('::')[0]);
      }
    };
  }
  return worker;
}

function storeSweepResult(ck, packedResults, packedMean) {
  const RESP_KEYS_LOCAL = ['x', 'v', 'Sv', 'h', 'I', 'J', 'Sa', 'SaN'];
  const results = packedResults.map((packed) => {
    const obj = {};
    for (const r of RESP_KEYS_LOCAL) obj[r] = packed[r] instanceof Float64Array ? packed[r] : new Float64Array(packed[r]);
    return obj;
  });
  const mean = {};
  for (const r of RESP_KEYS_LOCAL) mean[r] = packedMean[r] instanceof Float64Array ? packedMean[r] : new Float64Array(packedMean[r]);

  sweepCache[ck] = { results, mean };
  progressWrap.style.display = 'none';
  currentComputingKey = null;
  if (ck === cacheKey(registroSelect.value, methodSelect.value)) drawCurrentChart();
}

// Respaldo sin Web Worker: mismo cálculo (chopra.js), en el hilo principal,
// partido en lotes de T con setTimeout(0) para no congelar la interfaz.
function runSweepMainThreadFallback(key, method) {
  const rec = records[key];
  const def = rec.def;
  const compute = method === 'directa' ? computeOneDirect : computeOne;
  const ck = cacheKey(key, method);
  const nT = TGrid.length;
  const nXi = XI.length;
  const RESP_KEYS_LOCAL = ['x', 'v', 'Sv', 'h', 'I', 'J', 'Sa', 'SaN'];
  const results = [];
  for (let i = 0; i < nXi; i++) {
    const o = {};
    for (const r of RESP_KEYS_LOCAL) o[r] = new Float64Array(nT);
    results.push(o);
  }

  let ti = 0;
  const batchSize = 4;

  function step() {
    const end = Math.min(ti + batchSize, nT);
    for (; ti < end; ti++) {
      const Tp = TGrid[ti];
      for (let xi_i = 0; xi_i < nXi; xi_i++) {
        const out = compute(rec.agFull, def.dt, def.g, Tp, XI[xi_i]);
        const obj = results[xi_i];
        obj.x[ti] = out.x;
        obj.v[ti] = out.v;
        obj.Sv[ti] = out.Sv;
        obj.h[ti] = out.h;
        obj.I[ti] = out.I;
        obj.J[ti] = out.J;
        obj.Sa[ti] = out.Sa;
        obj.SaN[ti] = out.SaN;
      }
    }
    const pct = Math.round((ti / nT) * 100);
    progressBarInner.style.transform = `scaleX(${ti / nT})`;
    progressText.textContent = `Calculando (modo compatibilidad, sin Worker)… ${pct}%`;

    if (ti < nT) {
      setTimeout(step, 0);
    } else {
      const mean = {};
      for (const r of RESP_KEYS_LOCAL) {
        const arr = new Float64Array(nT);
        for (let t2 = 0; t2 < nT; t2++) {
          let sum = 0;
          for (let xi_i = 0; xi_i < nXi; xi_i++) sum += results[xi_i][r][t2];
          arr[t2] = sum / nXi;
        }
        mean[r] = arr;
      }
      storeSweepResult(ck, results, mean);
    }
  }
  step();
}

function ensureSweep(key) {
  const method = methodSelect.value;
  const ck = cacheKey(key, method);
  if (sweepCache[ck] || currentComputingKey === ck) return;
  const rec = records[key];
  const def = rec.def;
  currentComputingKey = ck;
  progressWrap.style.display = 'flex';
  progressBarInner.style.transform = 'scaleX(0)';
  progressText.textContent = 'Calculando… 0%';

  if (workerAvailable === false) {
    runSweepMainThreadFallback(key, method);
    return;
  }

  try {
    const w = getWorker();
    const agCopy = rec.agFull.slice(); // copia para transferir (conserva el original)
    const tCopy = TGridArr.slice();
    const xiCopy = Float64Array.from(XI);

    w.postMessage(
      { type: 'run', key: ck, dt: def.dt, g: def.g, ag: agCopy.buffer, TGrid: tCopy.buffer, XI: xiCopy.buffer, method },
      [agCopy.buffer, tCopy.buffer, xiCopy.buffer]
    );
  } catch (err) {
    console.warn('No se pudo crear el Web Worker; usando cálculo en el hilo principal.', err);
    workerAvailable = false;
    runSweepMainThreadFallback(key, method);
  }
}

function onRegistroChange() {
  const key = registroSelect.value;
  hideTooltip(accelOverlay, accelTooltip);
  hideTooltip(chartOverlay, chartTooltip);
  drawAccelChart(key); // no depende del barrido: se dibuja de inmediato con los datos ya cargados
  if (sweepCache[cacheKey(key, methodSelect.value)]) {
    drawCurrentChart();
  } else {
    ensureSweep(key);
    clearChart();
  }
}

function clearChart() {
  const ctx = chartCanvas.getContext('2d');
  ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
  legendEl.innerHTML = '';
  lastChartState = null;
  hideTooltip(chartOverlay, chartTooltip);
}

function drawCurrentChart() {
  const key = registroSelect.value;
  const respKey = respuestaSelect.value;
  const cached = sweepCache[cacheKey(key, methodSelect.value)];
  if (!cached) return;

  const def = records[key].def;
  const meta = RESP_META.find((m) => m.key === respKey);
  const unit = meta.unit === 'adim' ? '' : ` (${meta.unit.replace('len', def.lengthUnit)})`;

  const series = XI.map((xi, i) => ({
    key: XI_KEYS[i],
    data: cached.results[i][respKey],
    color: XI_COLORS[i],
    width: 1.75,
    dash: [],
    label: `ξ = ${(xi * 100).toFixed(0)}%`,
  }));
  series.push({
    key: 'mean',
    data: cached.mean[respKey],
    color: MEAN_COLOR,
    width: 2.75,
    dash: [7, 5],
    label: 'Media aritmética',
  });

  lastChartState = drawChart(chartCanvas, chartOverlay, TGrid, series, 'T (s)', `${meta.label}${unit}`);
  renderLegend(series);
  pulseChartIn(chartCanvas);

  const methodLabel = methodSelect.value === 'directa' ? 'Integración directa' : 'Chopra (8 constantes)';
  document.getElementById('spectrumTitle').textContent = `Espectro de respuesta — ${methodLabel}`;
}

function renderLegend(series) {
  legendEl.innerHTML = '';
  for (const s of series) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const hidden = hiddenSeriesKeys.has(s.key);
    item.dataset.hidden = String(hidden);
    item.setAttribute('aria-pressed', String(!hidden));
    item.setAttribute('aria-label', `Mostrar u ocultar ${s.label}`);

    const sw = document.createElement('span');
    sw.className = 'legend-swatch' + (s.dash.length ? ' legend-swatch--dashed' : '');
    sw.style.color = s.color;
    if (!s.dash.length) sw.style.backgroundColor = s.color;
    const txt = document.createElement('span');
    txt.textContent = s.label;
    item.appendChild(sw);
    item.appendChild(txt);

    const toggle = () => {
      if (hiddenSeriesKeys.has(s.key)) hiddenSeriesKeys.delete(s.key);
      else hiddenSeriesKeys.add(s.key);
      drawCurrentChart();
    };
    item.addEventListener('click', toggle);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    legendEl.appendChild(item);
  }
}

/* ============================== Acelerograma normalizado (ag/g vs t) ============================== */

const accelCanvas = document.getElementById('accelCanvas');
const accelOverlay = document.getElementById('accelOverlay');
const accelWrap = accelCanvas.parentElement;
const accelTooltip = document.getElementById('accelTooltip');
const ACCEL_COLOR = '#d97757';

let lastAccelState = null;

function drawAccelChart(key) {
  const rec = records[key];
  if (!rec) return;
  const def = rec.def;
  // Unidad común (cm/s²) para los 5 registros, aunque el archivo nativo de Bhuj
  // venga en m/s²: así el eje se lee en las mismas unidades que la tabla 1 del SPEC.
  const toCm = def.accelUnit === 'm/s²' ? 100 : 1;
  const n = rec.agFull.length;
  const t = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i * rec.dt;
    y[i] = rec.agFull[i] * toCm;
  }
  const series = [{ key: 'accel', data: y, color: ACCEL_COLOR, width: 1, dash: [], label: 'ag' }];
  // Eje Y fijo en ± el pico de referencia de la tabla 1 del SPEC (cm/s²), no un
  // valor auto-escalado con margen: el pico real toca exactamente el borde del
  // marco, y el máximo es literalmente el número pedido (104, 78, 69, 174, 131).
  lastAccelState = drawChart(accelCanvas, accelOverlay, t, series, 't (s)', 'ag(t)  [cm/s²]', {
    yFixedBound: def.peakCm,
    xTickCount: 5,
    xTickFormat: (v) => Math.round(v).toString(),
    yTickFormat: (v) => Math.round(v).toString(),
  });
  pulseChartIn(accelCanvas);
}

function pulseChartIn(canvas) {
  canvas.classList.remove('chart-fade-in');
  void canvas.offsetWidth; // fuerza reflow para reiniciar la animación
  canvas.classList.add('chart-fade-in');
}

/* ============================== Dibujo del gráfico (canvas 2D, con HiDPI) ============================== */

let lastChartState = null;

function sizeCanvasToContainer(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: w, H: h };
}

function formatTick(v) {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.001) return v.toFixed(4);
  return v.toExponential(1);
}

function drawChart(canvas, overlay, xData, series, xLabel, yLabel, opts) {
  opts = opts || {};
  const { ctx, W, H } = sizeCanvasToContainer(canvas);
  sizeCanvasToContainer(overlay); // mantiene el overlay del cursor alineado en tamaño/DPR
  ctx.clearRect(0, 0, W, H);

  const padL = 64, padR = 16, padT = 16, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const visible = series.filter((s) => !hiddenSeriesKeys.has(s.key));
  const xMin = xData[0], xMax = xData[xData.length - 1];

  // Los espectros son siempre >=0 (máximos absolutos): la base queda en 0.
  // Una señal con signo (p. ej. el acelerograma) usa un dominio simétrico
  // alrededor de 0, para no recortar la mitad negativa.
  let yMin, yMax;
  if (opts.yFixedBound != null) {
    // Límite fijo (p. ej. el pico de referencia de la sección 7), no auto-escalado:
    // el pico real toca exactamente el borde del marco.
    yMin = -opts.yFixedBound;
    yMax = opts.yFixedBound;
  } else {
    const source = visible.length ? visible : series;
    let dataMin = Infinity, dataMax = -Infinity;
    for (const s of source) {
      for (let i = 0; i < s.data.length; i++) {
        const v = s.data[i];
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
    }
    if (!isFinite(dataMin)) { dataMin = 0; dataMax = 1; }

    if (dataMin >= 0) {
      yMin = 0;
      yMax = dataMax > 0 ? dataMax * 1.08 : 1;
    } else {
      const bound = Math.max(Math.abs(dataMin), Math.abs(dataMax)) * 1.08 || 1;
      yMin = -bound;
      yMax = bound;
    }
  }

  const xToPx = (x) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (y) => padT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  const gridColor = 'rgba(241, 236, 225, 0.07)';
  const axisColor = 'rgba(241, 236, 225, 0.22)';
  const tickTextColor = '#a39d92';
  const labelColor = '#f1ece1';
  const monoFont = '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace';

  ctx.lineWidth = 1;
  ctx.font = `11px ${monoFont}`;

  const nXTicks = opts.xTickCount || 10;
  const xTickFormat = opts.xTickFormat || ((v) => v.toFixed(1));
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = tickTextColor;
  for (let i = 0; i <= nXTicks; i++) {
    const xv = xMin + (i / nXTicks) * (xMax - xMin);
    const px = Math.round(xToPx(xv)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + plotH);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(xTickFormat(xv), px, padT + plotH + 18);
  }

  const nYTicks = 6;
  const yTickFormat = opts.yTickFormat || formatTick;
  for (let i = 0; i <= nYTicks; i++) {
    const yv = yMin + (i / nYTicks) * (yMax - yMin);
    const py = Math.round(yToPx(yv)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(yTickFormat(yv), padL - 10, py + 3);
  }

  // Línea de referencia en cero (solo cuando el dominio la cruza, p. ej. una señal con signo)
  if (yMin < 0 && yMax > 0) {
    const zeroPy = Math.round(yToPx(0)) + 0.5;
    ctx.strokeStyle = axisColor;
    ctx.beginPath();
    ctx.moveTo(padL, zeroPy);
    ctx.lineTo(padL + plotW, zeroPy);
    ctx.stroke();
  }

  // ejes
  ctx.strokeStyle = axisColor;
  ctx.beginPath();
  ctx.moveTo(padL + 0.5, padT);
  ctx.lineTo(padL + 0.5, padT + plotH + 0.5);
  ctx.lineTo(padL + plotW, padT + plotH + 0.5);
  ctx.stroke();

  ctx.fillStyle = labelColor;
  ctx.textAlign = 'center';
  ctx.font = '600 12px "Inter", -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(xLabel, padL + plotW / 2, H - 8);
  ctx.save();
  ctx.translate(14, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  // curvas (ocultas se omiten; se dibuja la media al final para que quede al frente)
  const drawOrder = [...visible.filter((s) => s.key !== 'mean'), ...visible.filter((s) => s.key === 'mean')];
  const pointsPerPixel = xData.length / Math.max(1, plotW);
  const baselinePy = Math.round(yToPx(Math.max(yMin, Math.min(yMax, 0))));

  // Relleno degradado bajo la curva destacada (media aritmética), para que se
  // lea como la serie "hero" del gráfico en vez de una línea más entre seis.
  const heroSeries = drawOrder.find((s) => s.key === 'mean');
  if (heroSeries && pointsPerPixel <= 2) {
    const grad = ctx.createLinearGradient(0, padT, 0, baselinePy);
    grad.addColorStop(0, hexToRgba(heroSeries.color, 0.22));
    grad.addColorStop(1, hexToRgba(heroSeries.color, 0));
    ctx.beginPath();
    ctx.moveTo(xToPx(xData[0]), baselinePy);
    for (let i = 0; i < xData.length; i++) ctx.lineTo(xToPx(xData[i]), yToPx(heroSeries.data[i]));
    ctx.lineTo(xToPx(xData[xData.length - 1]), baselinePy);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  for (const s of drawOrder) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.setLineDash(s.dash);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (s.key === 'mean') {
      ctx.shadowColor = hexToRgba(s.color, 0.55);
      ctx.shadowBlur = 6;
    } else {
      ctx.shadowBlur = 0;
    }

    if (pointsPerPixel > 2) {
      // Señal muy sobremuestreada (p. ej. un acelerograma de miles de puntos
      // sobre unos cientos de píxeles): se dibuja como forma de onda, con el
      // rango [mín, máx] de cada columna de píxel, en vez de una polilínea
      // que aliasearía sobre sí misma.
      ctx.beginPath();
      let col = null, colMin = 0, colMax = 0, open = false;
      const flush = () => {
        const top = Math.min(colMin, colMax);
        const bottom = Math.max(colMin, colMax, top + 0.8);
        ctx.moveTo(col, top);
        ctx.lineTo(col, bottom);
      };
      for (let i = 0; i < xData.length; i++) {
        const px = Math.round(xToPx(xData[i])) + 0.5;
        const py = yToPx(s.data[i]);
        if (!open) { col = px; colMin = py; colMax = py; open = true; }
        else if (px === col) {
          if (py < colMin) colMin = py;
          if (py > colMax) colMax = py;
        } else {
          flush();
          col = px; colMin = py; colMax = py;
        }
      }
      if (open) flush();
      ctx.stroke();
    } else {
      // Curva suavizada: bezier cuadrática por el punto medio entre muestras
      // consecutivas, en vez de segmentos rectos (aspecto de gráfico trazado
      // a mano en vez de una polilínea de datos crudos).
      ctx.beginPath();
      const px0 = xToPx(xData[0]), py0 = yToPx(s.data[0]);
      ctx.moveTo(px0, py0);
      let prevX = px0, prevY = py0;
      for (let i = 1; i < xData.length; i++) {
        const px = xToPx(xData[i]);
        const py = yToPx(s.data[i]);
        const midX = (prevX + px) / 2, midY = (prevY + py) / 2;
        ctx.quadraticCurveTo(prevX, prevY, midX, midY);
        prevX = px; prevY = py;
      }
      ctx.lineTo(prevX, prevY);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  return { xData, series, padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, xToPx, yToPx };
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16);
  const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16);
  const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ============================== Interacción: crosshair + tooltip (genérico, reutilizado por ambos gráficos) ============================== */

function hideTooltip(overlay, tooltip) {
  tooltip.hidden = true;
  const octx = overlay.getContext('2d');
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

function nearestIndexGeneric(xData, xVal) {
  let lo = 0, hi = xData.length - 1;
  if (xVal <= xData[0]) return 0;
  if (xVal >= xData[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xData[mid] < xVal) lo = mid + 1;
    else hi = mid;
  }
  const before = lo > 0 ? lo - 1 : lo;
  return xVal - xData[before] <= xData[lo] - xVal ? before : lo;
}

function onChartPointer(clientX, clientY, canvas, overlay, tooltip, wrap, getState, formatX) {
  const state = getState();
  if (!state) return;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const { padL, plotW, padT, plotH, xMin, xMax, xData, series, yToPx } = state;

  if (mx < padL || mx > padL + plotW || my < padT || my > padT + plotH) { hideTooltip(overlay, tooltip); return; }

  const xVal = xMin + ((mx - padL) / plotW) * (xMax - xMin);
  const idx = nearestIndexGeneric(xData, Math.max(xMin, Math.min(xMax, xVal)));
  const xAt = xData[idx];
  const px = state.xToPx(xAt);

  const octx = overlay.getContext('2d');
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.save();
  const dpr = window.devicePixelRatio || 1;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  octx.strokeStyle = 'rgba(241, 236, 225, 0.22)';
  octx.lineWidth = 1;
  octx.setLineDash([3, 3]);
  octx.beginPath();
  octx.moveTo(Math.round(px) + 0.5, padT);
  octx.lineTo(Math.round(px) + 0.5, padT + plotH);
  octx.stroke();
  octx.setLineDash([]);

  const visible = series.filter((s) => !hiddenSeriesKeys.has(s.key));
  const rows = [];
  for (const s of visible) {
    const val = s.data[idx];
    const py = yToPx(val);
    // halo suave + núcleo sólido, en vez de un punto plano
    octx.beginPath();
    octx.fillStyle = hexToRgba(s.color, 0.22);
    octx.arc(px, py, 6.5, 0, Math.PI * 2);
    octx.fill();
    octx.beginPath();
    octx.fillStyle = s.color;
    octx.arc(px, py, 3, 0, Math.PI * 2);
    octx.fill();
    octx.lineWidth = 1.2;
    octx.strokeStyle = '#07080a';
    octx.stroke();
    rows.push({ color: s.color, label: s.label, val });
  }
  octx.restore();

  if (rows.length) {
    rows.sort((a, b) => b.val - a.val);
    tooltip.innerHTML =
      `<div class="chart-tooltip__t">${formatX(xAt)}</div>` +
      rows.map((r) => `<div class="chart-tooltip__row"><span class="chart-tooltip__dot" style="background:${r.color}"></span>${r.label}<span class="chart-tooltip__val">${formatTick(r.val)}</span></div>`).join('');
    tooltip.hidden = false;

    const wrapRect = wrap.getBoundingClientRect();
    let left = mx + 16;
    let top = my - 10;
    const ttW = tooltip.offsetWidth || 160;
    const ttH = tooltip.offsetHeight || 80;
    if (left + ttW > wrapRect.width - 4) left = mx - ttW - 16;
    if (top + ttH > wrapRect.height - 4) top = wrapRect.height - ttH - 4;
    if (top < 4) top = 4;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  } else {
    tooltip.hidden = true;
  }
}

chartCanvas.addEventListener('mousemove', (e) =>
  onChartPointer(e.clientX, e.clientY, chartCanvas, chartOverlay, chartTooltip, chartWrap, () => lastChartState, (x) => `T = ${x.toFixed(3)} s`)
);
chartCanvas.addEventListener('mouseleave', () => hideTooltip(chartOverlay, chartTooltip));

accelCanvas.addEventListener('mousemove', (e) =>
  onChartPointer(e.clientX, e.clientY, accelCanvas, accelOverlay, accelTooltip, accelWrap, () => lastAccelState, (x) => `t = ${x.toFixed(3)} s`)
);
accelCanvas.addEventListener('mouseleave', () => hideTooltip(accelOverlay, accelTooltip));

let resizeRaf = null;
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (sweepCache[cacheKey(registroSelect.value, methodSelect.value)]) drawCurrentChart();
    if (records[registroSelect.value]) drawAccelChart(registroSelect.value);
  });
});
