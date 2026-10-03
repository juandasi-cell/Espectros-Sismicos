// Núcleo de cálculo — método de Chopra de 8 constantes (interpolación de la excitación).
// Compartido entre el hilo principal (validación puntual) y el Web Worker (barrido completo)
// para garantizar que ambos usan exactamente el mismo algoritmo.
//
// ag: Float64Array de aceleración del suelo YA preparada:
//     ag[0] = 0 (reposo, t=0), ag[1..N] = datos del archivo, ag[N+1] = 0 (fuerza siguiente nula).
// dt: paso de tiempo del registro (s)
// g:  gravedad en la unidad nativa del registro
// T:  periodo (s)
// xi: razón de amortiguamiento crítico (0..1)
//
// Devuelve los 8 valores de respuesta definidos en la sección 4 del SPEC.

function computeOne(ag, dt, g, T, xi) {
  const wn = (2 * Math.PI) / T;
  const wn2 = wn * wn;
  const r = Math.sqrt(1 - xi * xi);
  const wd = wn * r;
  const ex = Math.exp(-xi * wn * dt);
  const s = Math.sin(wd * dt);
  const cs = Math.cos(wd * dt);
  const k = wn2; // m = 1

  const A = ex * ((xi / r) * s + cs);
  const B = ex * (s / wd);
  const C =
    (1 / k) *
    (2 * xi / (wn * dt) +
      ex *
        (((1 - 2 * xi * xi) / (wd * dt) - xi / r) * s -
          (1 + 2 * xi / (wn * dt)) * cs));
  const D =
    (1 / k) *
    (1 -
      2 * xi / (wn * dt) +
      ex * (((2 * xi * xi - 1) / (wd * dt)) * s + (2 * xi / (wn * dt)) * cs));

  const Ap = -ex * (wn / r) * s;
  const Bp = ex * (cs - (xi / r) * s);
  const Cp = (1 / k) * (-1 / dt + ex * ((wn / r + xi / (dt * r)) * s + (1 / dt) * cs));
  const Dp = (1 / (k * dt)) * (1 - ex * ((xi / r) * s + cs));

  const cDamp = 2 * xi * wn;
  const nSteps = ag.length - 1;

  let x = 0,
    v = 0;
  let xMax = 0,
    vMax = 0,
    hMax = 0,
    iMax = 0;

  for (let i = 0; i < nSteps; i++) {
    const pi = -ag[i];
    const pi1 = -ag[i + 1];

    const xn = A * x + B * v + C * pi + D * pi1;
    const vn = Ap * x + Bp * v + Cp * pi + Dp * pi1;

    const H = -ag[i + 1] - cDamp * vn - k * xn;
    const I = ag[i + 1] + H;

    x = xn;
    v = vn;

    const ax = Math.abs(x);
    if (ax > xMax) xMax = ax;
    const av = Math.abs(v);
    if (av > vMax) vMax = av;
    const ah = Math.abs(H);
    if (ah > hMax) hMax = ah;
    const ai = Math.abs(I);
    if (ai > iMax) iMax = ai;
  }

  const Sa = xMax * wn2;
  return {
    x: xMax,
    v: vMax,
    Sv: xMax * wn,
    h: hMax,
    I: iMax,
    J: iMax / g,
    Sa: Sa,
    SaN: Sa / g,
  };
}

// Método de integración directa (interpolación lineal de la excitación),
// tal como está implementado en "Excel 1 - Integracion Directa": en cada paso
// se descompone la respuesta en una solución particular (N: pendiente, O:
// término constante, debidas a la fuerza interpolada linealmente en el
// intervalo) más una solución homogénea amortiguada (P, Q: coeficientes de
// coseno y seno ajustados a x[i], v[i]). Es la misma solución exacta que el
// método de Chopra de 8 constantes, pero aquí se recalcula paso a paso en vez
// de precomputar 8 constantes reutilizables — por eso el SPEC los llama
// "algebraicamente equivalentes" (diferencia validada en Excel: 6.7e-11).
function computeOneDirect(ag, dt, g, T, xi) {
  const wn = (2 * Math.PI) / T;
  const wn2 = wn * wn;
  const wd = wn * Math.sqrt(1 - xi * xi);
  const ex = Math.exp(-xi * wn * dt);
  const s = Math.sin(wd * dt);
  const cs = Math.cos(wd * dt);
  const k = wn2; // m = 1
  const c = 2 * xi * wn;
  const nSteps = ag.length - 1;

  let x = 0,
    v = 0;
  let xMax = 0,
    vMax = 0,
    hMax = 0,
    iMax = 0;

  for (let i = 0; i < nSteps; i++) {
    const pi = -ag[i];
    const pi1 = -ag[i + 1];

    const N = (pi1 - pi) / (k * dt);
    const O = (pi - c * N) / k;
    const P = x - O;
    const Q = (v + (P * xi * wn - N)) / wd;

    const xn = ex * (P * cs + Q * s) + O + N * dt;
    const vn = ex * ((Q * wd - P * xi * wn) * cs - (P * wd + Q * xi * wn) * s) + N;

    const H = -ag[i + 1] - c * vn - k * xn;
    const I = ag[i + 1] + H;

    x = xn;
    v = vn;

    const ax = Math.abs(x);
    if (ax > xMax) xMax = ax;
    const av = Math.abs(v);
    if (av > vMax) vMax = av;
    const ah = Math.abs(H);
    if (ah > hMax) hMax = ah;
    const ai = Math.abs(I);
    if (ai > iMax) iMax = ai;
  }

  const Sa = xMax * wn2;
  return {
    x: xMax,
    v: vMax,
    Sv: xMax * wn,
    h: hMax,
    I: iMax,
    J: iMax / g,
    Sa: Sa,
    SaN: Sa / g,
  };
}

// En Node/worker (importScripts) y en navegador (script clásico) quedan globales.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeOne, computeOneDirect };
}
