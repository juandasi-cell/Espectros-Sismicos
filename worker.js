// Web Worker: barrido de espectros de respuesta. Reutiliza computeOne()
// (método de Chopra, 8 constantes) y computeOneDirect() (integración directa,
// interpolación lineal de la excitación) de chopra.js, para garantizar el
// mismo algoritmo que la validación puntual (sección 7 del SPEC) hecha en el
// hilo principal.

importScripts('chopra.js');

const RESP = ['x', 'v', 'Sv', 'h', 'I', 'J', 'Sa', 'SaN'];

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'run') return;

  const { key, dt, g, ag, TGrid, XI, method } = msg;
  const compute = method === 'directa' ? computeOneDirect : computeOne;
  const agArr = new Float64Array(ag);
  const T = new Float64Array(TGrid);
  const xiArr = new Float64Array(XI);

  const nT = T.length;
  const nXi = xiArr.length;

  const results = [];
  for (let xi_i = 0; xi_i < nXi; xi_i++) {
    const obj = {};
    for (const r of RESP) obj[r] = new Float64Array(nT);
    results.push(obj);
  }

  let done = 0;
  const total = nT * nXi;
  const progressStep = Math.max(1, Math.floor(nT / 100));

  for (let ti = 0; ti < nT; ti++) {
    const Tp = T[ti];
    for (let xi_i = 0; xi_i < nXi; xi_i++) {
      const out = compute(agArr, dt, g, Tp, xiArr[xi_i]);
      const obj = results[xi_i];
      obj.x[ti] = out.x;
      obj.v[ti] = out.v;
      obj.Sv[ti] = out.Sv;
      obj.h[ti] = out.h;
      obj.I[ti] = out.I;
      obj.J[ti] = out.J;
      obj.Sa[ti] = out.Sa;
      obj.SaN[ti] = out.SaN;
      done++;
    }

    if (ti % progressStep === 0 || ti === nT - 1) {
      self.postMessage({ type: 'progress', key, pct: done / total });
    }
  }

  // Media aritmética entre los 5 xi, por respuesta y por T
  const mean = {};
  for (const r of RESP) {
    const arr = new Float64Array(nT);
    for (let ti = 0; ti < nT; ti++) {
      let sum = 0;
      for (let xi_i = 0; xi_i < nXi; xi_i++) sum += results[xi_i][r][ti];
      arr[ti] = sum / nXi;
    }
    mean[r] = arr;
  }

  const transferList = [];
  const packedResults = results.map((obj) => {
    const packed = {};
    for (const r of RESP) {
      packed[r] = obj[r].buffer;
      transferList.push(obj[r].buffer);
    }
    return packed;
  });
  const packedMean = {};
  for (const r of RESP) {
    packedMean[r] = mean[r].buffer;
    transferList.push(mean[r].buffer);
  }

  self.postMessage(
    { type: 'done', key, results: packedResults, mean: packedMean, nT },
    transferList
  );
};
