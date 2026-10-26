/* =============================================================================
 *  Gastos con tarjeta y efectivo — Lucciano's (frontend)
 *  Vanilla JS, sin build. Habla con el Worker (window.GASTOS_API).
 *  Rutas: #/inicio, #/revisar, #/comprobantes, #/comprobante/ID, #/shares,
 *         #/resumenes, #/resumen/ID, #/admin, #/guia, #/cuenta
 * ============================================================================= */
'use strict';

// ---------------------------------------------------------------------------
//  Estado y utilidades
// ---------------------------------------------------------------------------
const API = (() => {
  // ?api=http://localhost:8787 permite apuntar a otro Worker (pruebas)
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q) localStorage.setItem('gastos_api', q);
    return (localStorage.getItem('gastos_api') || window.GASTOS_API).replace(/\/$/, '');
  } catch { return String(window.GASTOS_API).replace(/\/$/, ''); }
})();

const S = { token: null, user: null, arca: 'off', cuentas: null, pdfUrl: null, vista: null };
try { S.token = localStorage.getItem('gastos_token'); } catch { /* sin storage */ }

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NIVEL = { carga: 1, aprobador: 2, admin: 3 };
const puede = (rol) => S.user && NIVEL[S.user.rol] >= NIVEL[rol];

const fmtNum = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Formateadores a prueba de datos raros: nunca devuelven "undefined", "NaN" ni "Invalid Date".
const $$m = (n) => { if (n === null || n === undefined || n === '') return '—'; const x = Number(n); return Number.isFinite(x) ? '$ ' + fmtNum.format(x) : '—'; };
// Fechas: acepta AAAA-MM-DD (nuestra base) y DD/MM/AAAA (Shares); cualquier otra cosa se muestra tal cual
const fmtF = (v) => {
  if (!v) return '—';
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/))) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
};
const fmtFH = (s) => {
  if (!s) return '—';
  const t = String(s);
  const d = new Date(t.replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/.test(t) || !/\d{2}:\d{2}/.test(t) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? fmtF(t) : d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
};
const nroCbte = (f) => (f.pto_vta != null && f.numero != null) ? `${String(f.pto_vta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}` : '—';
const fmtCuit = (c) => { c = String(c || ''); return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : (c || '—'); };
const TIPOS = { 1: 'FA', 2: 'ND A', 3: 'NC A', 6: 'FB', 7: 'ND B', 8: 'NC B', 11: 'FC', 12: 'ND C', 13: 'NC C', 51: 'FM', 52: 'ND M', 53: 'NC M', 201: 'FCE A', 202: 'ND FCE A', 203: 'NC FCE A', 206: 'FCE B', 207: 'ND FCE B', 208: 'NC FCE B', 211: 'FCE C', 212: 'ND FCE C', 213: 'NC FCE C', 17: 'LSP A', 18: 'LSP B', 81: 'TFA', 82: 'TFB', 83: 'Tique' };
const ESTADOS = { leyendo: 'Leyendo', error_lectura: 'No se pudo leer', excepcion: 'Para revisar', lista: 'Lista para Shares', cargada: 'Cargada en Shares', error_shares: 'Error Shares', rechazada: 'Rechazada' };
const badgeEstado = (e) => `<span class="badge b-${esc(e)}">${esc(ESTADOS[e] || e)}</span>`;
const JURIS = ['BUENOS AIRES', 'CABA', 'CORDOBA', 'SANTA FE', 'MENDOZA', 'NEUQUEN', 'SALTA', 'TUCUMAN', 'CHACO', 'MISIONES', 'RIO NEGRO', 'CORRIENTES', 'CHUBUT', 'LA PAMPA', 'TIERRA DEL FUEGO'];

function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'ver' + (error ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, error ? 6000 : 3000);
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  // "Failed to fetch" = no llegó ninguna respuesta (corte de red, el Worker se reinició o se pasó de tiempo).
  // Las consultas (GET) se reintentan solas 2 veces; las que modifican datos no, para no duplicar nada.
  let res;
  for (let intento = 0; ; intento++) {
    try {
      res = await fetch(API + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (method === 'GET' && [502, 503, 504].includes(res.status) && intento < 2) throw new TypeError('HTTP ' + res.status);
      break;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (method !== 'GET' || intento >= 2) throw new Error(method === 'GET' ? 'No hay conexión con el servidor. Probá de nuevo en unos segundos.' : 'Se cortó la conexión y no sé si se guardó. Recargá la factura antes de volver a intentar.');
      await new Promise(r => setTimeout(r, 700 * (intento + 1)));
    }
  }
  if (res.status === 401 && S.token && !path.startsWith('/api/login')) {
    salir(false);
    throw new Error('La sesión venció. Volvé a ingresar.');
  }
  if (raw) { if (!res.ok) throw new Error('HTTP ' + res.status); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// Envuelve un botón: lo deshabilita con spinner mientras corre la acción
async function conBoton(btn, fn) {
  const txt = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cargando"></span>'; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = txt; } }
}

function modal(html, { ancho = false, alMontar } = {}) {
  const m = $('#modal');
  $('.modal-box', m).classList.toggle('ancho', ancho);
  $('.modal-cuerpo', m).innerHTML = html;
  m.hidden = false;
  const cerrar = () => { m.hidden = true; $('.modal-cuerpo', m).innerHTML = ''; };
  $('.modal-cerrar', m).onclick = cerrar;
  m.onclick = (e) => { if (e.target === m) cerrar(); };
  if (alMontar) alMontar($('.modal-cuerpo', m), cerrar);
  const primero = $('input, textarea, select', m);
  if (primero) setTimeout(() => primero.focus(), 30);
  return cerrar;
}

// Confirmación propia (en vez de confirm() del navegador, que Chrome puede bloquear en silencio
// si alguna vez se tildó "no permitir más diálogos": ahí el botón parece no hacer nada)
function confirmar(texto, { boton = 'Sí, seguir', peligro = false } = {}) {
  return new Promise((resolve) => {
    let hecho = false;
    modal(`<h2 style="margin-bottom:6px">¿Confirmás?</h2><p class="muted" style="white-space:pre-line;margin:0 0 18px">${esc(texto)}</p>
      <div class="acciones" style="justify-content:flex-end"><button class="btn" data-no>Cancelar</button><button class="btn ${peligro ? 'btn-rojo' : 'btn-acento'}" data-si>${esc(boton)}</button></div>`, {
      alMontar: (el, cerrar) => {
        const fin = (v) => { if (hecho) return; hecho = true; cerrar(); resolve(v); };
        $('[data-si]', el).onclick = () => fin(true);
        $('[data-no]', el).onclick = () => fin(false);
        setTimeout(() => $('[data-si]', el)?.focus(), 0);
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!hecho) { hecho = true; resolve(false); } } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

function pedirTexto({ titulo, ayuda = '', etiqueta = 'Comentario', boton = 'Confirmar', minimo = 5, valor = '' }) {
  return new Promise((resolve) => {
    let listo = false;
    modal(`<h2>${esc(titulo)}</h2>${ayuda ? `<p class="muted">${esc(ayuda)}</p>` : ''}
      <div class="campo"><label>${esc(etiqueta)}</label><textarea id="pt-txt">${esc(valor)}</textarea></div>
      <div class="acciones"><button class="btn btn-negro" id="pt-ok">${esc(boton)}</button><button class="btn" id="pt-no">Cancelar</button></div>`, {
      alMontar: (el, cerrar) => {
        $('#pt-ok', el).onclick = () => {
          const v = $('#pt-txt', el).value.trim();
          if (v.length < minimo) { toast(`Escribí al menos ${minimo} caracteres.`, true); return; }
          listo = true; cerrar(); resolve(v);
        };
        $('#pt-no', el).onclick = () => { cerrar(); resolve(null); };
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!listo) resolve(null); } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

async function cuentas(forzar = false) {
  if (!S.cuentas || forzar) S.cuentas = (await api('/api/cuentas')).cuentas;
  return S.cuentas;
}
function nombreCuenta(cod) {
  const c = (S.cuentas || []).find(x => String(x.codigo_concepto) === String(cod));
  return c ? c.denominacion : '';
}
function datalistCuentas() {
  return `<datalist id="dl-cuentas">${(S.cuentas || []).map(c => `<option value="${c.codigo_concepto}">${esc(c.denominacion)}</option>`).join('')}</datalist>`;
}

// Lee un Excel/CSV con SheetJS → array de filas (array de arrays)
async function leerPlanilla(file) {
  if (!window.XLSX) throw new Error('No cargó la librería de Excel. Revisá la conexión.');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
}
function descargarCsv(nombre, filas) {
  const csv = filas.map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
//  Sesión
// ---------------------------------------------------------------------------
function guardarToken(t) { S.token = t; try { t ? localStorage.setItem('gastos_token', t) : localStorage.removeItem('gastos_token'); } catch { } }
async function salir(llamarApi = true) {
  if (llamarApi) await api('/api/logout', { method: 'POST' }).catch(() => null);
  guardarToken(null); S.user = null; S.cuentas = null;
  location.hash = '';
  vistaLogin();
}

// ---------------------------------------------------------------------------
//  Íconos (trazo de 2px, estilo feather) y avatares
// ---------------------------------------------------------------------------
const svgI = (p) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  home: svgI('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  inbox: svgI('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  doc: svgI('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  send: svgI('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  users: svgI('<path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M17 11a3 3 0 1 0 0-6M21 21v-2a4 4 0 0 0-3-3.87"/>'),
  gear: svgI('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  upload: svgI('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  refresh: svgI('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  logout: svgI('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  check: svgI('<path d="M20 6 9 17l-5-5"/>'),
  arrow: svgI('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  back: svgI('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
  user: svgI('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>'),
  copy: svgI('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  shield: svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  calc: svgI('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h8"/>'),
  x: svgI('<path d="M6 6l12 12M18 6 6 18"/>'),
  mail: svgI('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
  sparkle: svgI('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  sun: svgI('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svgI('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  info: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
  alert: svgI('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  coin: svgI('<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a2.5 2.5 0 0 0-2.5-1.5c-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2a2.6 2.6 0 0 1-2.5-1.5M12 6.5V8M12 16v1.5"/>'),
  ojo: svgI('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  ojoNo: svgI('<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>'),
  clock: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  calendar: svgI('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'),
  chart: svgI('<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-8"/>'),
  chat: svgI('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>'),
  phone: svgI('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
  sliders: svgI('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  camara: svgI('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  tarjeta: svgI('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>'),
  book: svgI('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
};
const COLORES_AV = ['#b0254a', '#2d5bba', '#1f7a45', '#a85a07', '#6b4bb8', '#0f7d86', '#7a4a2e', '#c0392b'];
const iniciales = (s) => String(s || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(SRL|SAS|S\.?A\.?|SA|SOCIEDAD|ANONIMA)$/i.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase() || String(s || '?').slice(0, 1).toUpperCase();
const colorDe = (s) => COLORES_AV[[...String(s || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORES_AV.length];
const cuad = (s) => `<span class="cuad" style="background:${colorDe(s)}" aria-hidden="true">${esc(iniciales(s))}</span>`;
const nombreProv = (f) => f.razon_social_emisor || 'Sin identificar';
const $$corto = (n) => { n = Number(n) || 0; return Math.abs(n) >= 1e6 ? '$ ' + (n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M' : $$m(n); };

// Ojito para ver la contraseña: se agrega solo a cualquier campo de contraseña que aparezca (login, Mi cuenta, modales)
function ojosClave(root = document) {
  $$('input[type="password"]:not([data-ojo])', root).forEach(inp => {
    inp.dataset.ojo = '1';
    const caja = document.createElement('span');
    caja.className = 'clave-caja';
    inp.parentNode.insertBefore(caja, inp);
    caja.appendChild(inp);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'clave-ojo'; b.tabIndex = -1;
    b.setAttribute('aria-label', 'Mostrar contraseña'); b.title = 'Mostrar contraseña';
    b.innerHTML = ICO.ojo;
    b.onclick = () => {
      const ver = inp.type === 'password';
      inp.type = ver ? 'text' : 'password';
      b.innerHTML = ver ? ICO.ojoNo : ICO.ojo;
      const t = ver ? 'Ocultar contraseña' : 'Mostrar contraseña';
      b.setAttribute('aria-label', t); b.title = t;
      inp.focus();
    };
    caja.appendChild(b);
  });
}
new MutationObserver(() => ojosClave()).observe(document.documentElement, { childList: true, subtree: true });

// Tema claro/oscuro (lo inicializa index.html antes de pintar)
function temaActual() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function alternarTema() {
  const nuevo = temaActual() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem('gastos_tema', nuevo); } catch { }
  const b = $('#b-tema'); if (b) b.innerHTML = nuevo === 'dark' ? ICO.sun : ICO.moon;
}


// ---- Actualizar: trae datos frescos y, si hay una versión nueva de la app, la carga ----
async function actualizar() {
  const b = $('#b-actualizar');
  if (b) b.classList.add('girando');
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.update().catch(() => null);
      if (reg.waiting || reg.installing) { location.reload(); return; }
    }
    S.cnt = null; S.cuentas = null;
    await router();
    toast('Actualizado');
  } finally { const x = $('#b-actualizar'); if (x) x.classList.remove('girando'); }
}

// ---- App instalable (celular) ----
const esStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; $$('[data-instalar]').forEach(x => pintarInstalar(x)); });
window.addEventListener('appinstalled', () => { S.instalar = null; toast('Listo: la app quedó en tu pantalla de inicio'); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => null));
}
// Tarjeta "Instalar en el celular" (Mi cuenta)
function pintarInstalar(el) {
  if (esStandalone()) { el.innerHTML = `<p class="con-ico">${ICO.check}Ya la estás usando como app instalada.</p>`; return; }
  if (S.instalar) {
    el.innerHTML = `<p class="muted">Queda con el logo de Lucciano's en tu pantalla de inicio y abre directo, sin el navegador.</p><button class="btn btn-acento" data-btn-instalar>${ICO.phone}Instalar la app</button>`;
    $('[data-btn-instalar]', el).onclick = async () => { const p = S.instalar; S.instalar = null; p.prompt(); await p.userChoice.catch(() => null); pintarInstalar(el); };
    return;
  }
  el.innerHTML = esIOS()
    ? `<p class="muted">En el iPhone, abrí la app en <b>Safari</b>, tocá el botón <b>Compartir</b> (el cuadrado con la flecha para arriba) y elegí <b>“Agregar a inicio”</b>.</p>`
    : `<p class="muted">Abrí la app en <b>Chrome</b> desde el celular, tocá el menú <b>⋮</b> y elegí <b>“Instalar app”</b> o <b>“Agregar a la pantalla principal”</b>.</p>`;
}
const bloqueInstalar = () => `<div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:8px">Instalar en el celular</h2><div data-instalar></div></div>`;
function montarInstalar(root = document) { $$('[data-instalar]', root).forEach(x => pintarInstalar(x)); }


const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let _pdfjsCarga = null;
function cargarPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!_pdfjsCarga) _pdfjsCarga = new Promise((ok, mal) => {
    const sc = document.createElement('script');
    sc.src = PDFJS + 'pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
    sc.onerror = () => { _pdfjsCarga = null; mal(new Error('no cargó pdf.js')); };
    document.head.appendChild(sc);
  });
  return _pdfjsCarga;
}

async function cargarPdf(ruta) {
  if (!$('#visor')) return;
  try {
    const res = await api(ruta, { raw: true });
    const blob = await res.blob();
    if (S.pdfUrl) URL.revokeObjectURL(S.pdfUrl);
    S.pdfUrl = URL.createObjectURL(blob);
    S.pdfBytes = new Uint8Array(await blob.arrayBuffer());
    await mostrarPdf();
  } catch (e) {
    if ($('#visor')) $('#visor').innerHTML = `<div class="vacio">No se pudo cargar el PDF: ${esc(e.message)}</div>`;
  }
}

async function mostrarPdf() {
  const visor = $('#visor');
  if (!visor || !S.pdfUrl) return;
  S.pdfZoom = S.pdfZoom || 1;
  visor.innerHTML = `<div class="pdf-barra">
      <button class="ibtn" data-z="-" title="Alejar" aria-label="Alejar">${svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>')}</button>
      <span class="pdf-zoom">${Math.round(S.pdfZoom * 100)}%</span>
      <button class="ibtn" data-z="+" title="Acercar" aria-label="Acercar">${svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>')}</button>
      <button class="ibtn" data-z="1" title="Ajustar al ancho" aria-label="Ajustar al ancho">${svgI('<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>')}</button>
      <span style="flex:1"></span>
      <a class="ibtn" href="${S.pdfUrl}" target="_blank" rel="noopener" title="Abrir en pestaña nueva" aria-label="Abrir en pestaña nueva">${svgI('<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>')}</a>
      <a class="ibtn" href="${S.pdfUrl}" download="factura.pdf" title="Descargar" aria-label="Descargar">${svgI('<path d="M12 3v12M8 11l4 4 4-4M4 21h16"/>')}</a>
    </div><div class="pdf-paginas" id="pdf-paginas"><div class="vacio"><span><span class="cargando"></span> Abriendo PDF…</span></div></div>`;
  $$('[data-z]', visor).forEach(b => b.onclick = () => {
    S.pdfZoom = b.dataset.z === '1' ? 1 : Math.min(3, Math.max(0.5, S.pdfZoom + (b.dataset.z === '+' ? 0.25 : -0.25)));
    mostrarPdf();
  });
  const cont = $('#pdf-paginas', visor);
  let pdfjs;
  try { pdfjs = await cargarPdfjs(); }
  catch { cont.innerHTML = `<iframe src="${S.pdfUrl}#view=FitH&navpanes=0" title="PDF de la factura"></iframe>`; cont.classList.add('con-iframe'); return; }
  try {
    const doc = await pdfjs.getDocument({ data: S.pdfBytes.slice() }).promise;
    if (!cont.isConnected) return;
    cont.innerHTML = '';
    const ancho = Math.max(280, cont.clientWidth - 24) * S.pdfZoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    for (let n = 1; n <= doc.numPages; n++) {
      const pag = await doc.getPage(n);
      const base = pag.getViewport({ scale: 1 });
      const vp = pag.getViewport({ scale: (ancho / base.width) * dpr });
      const cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
      cv.style.width = Math.floor(vp.width / dpr) + 'px';
      cv.title = 'Doble clic: abrir en pestaña nueva';
      cv.ondblclick = () => window.open(S.pdfUrl, '_blank', 'noopener');
      if (!cont.isConnected) return;
      cont.appendChild(cv);
      await pag.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    if (doc.numPages > 1) cont.insertAdjacentHTML('beforeend', `<div class="pdf-pie">${doc.numPages} páginas</div>`);
  } catch (e) {
    cont.innerHTML = `<iframe src="${S.pdfUrl}#view=FitH&navpanes=0" title="PDF de la factura"></iframe>`; cont.classList.add('con-iframe');
  }
}


function vacioDatos() {
  return { emisor: {}, receptor: {}, comprobante: { moneda: 'PES', tipo_autorizacion: 'CAE' }, importes: { gravado: [] }, percepciones: [], pago: {}, imputacion: {} };
}
function filaGravado(g = {}) {
  return `<div class="grid-items" data-grav>
    <select data-k="alicuota">${[21, 10.5, 27, 5, 2.5].map(a => `<option value="${a}" ${Number(g.alicuota) === a ? 'selected' : ''}>${String(a).replace('.', ',')}%</option>`).join('')}</select>
    <input data-k="neto" class="num" value="${esc(g.neto ?? '')}"><input data-k="iva" class="num" value="${esc(g.iva ?? '')}">
    <button type="button" class="btn btn-chico" data-quitar title="Quitar">×</button></div>`;
}
function filaPercepcion(p = {}) {
  return `<div class="grid-perc" data-perc>
    <select data-k="tipo">${['IVA', 'IIBB', 'GANANCIAS', 'MUNICIPAL', 'OTRO'].map(t => `<option ${p.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <select data-k="jurisdiccion"><option value="">—</option>${JURIS.map(j => `<option ${p.jurisdiccion === j ? 'selected' : ''}>${j}</option>`).join('')}</select>
    <input data-k="importe" class="num" value="${esc(p.importe ?? '')}">
    <button type="button" class="btn btn-chico" data-quitar title="Quitar">×</button></div>`;
}
const numAR = (v) => { let s = String(v ?? '').trim().replace(/[$\s]/g, ''); if (!s) return 0; if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); return Number(s) || 0; };

function leerFormulario(base) {
  const f = $('#f-datos');
  const d = JSON.parse(JSON.stringify(base || vacioDatos()));
  for (const el of $$('[name]', f)) {
    const [a, b] = el.name.split('.');
    d[a] = d[a] || {};
    d[a][b] = el.value === '' ? null : el.value;
  }
  d.importes.gravado = $$('[data-grav]', f).map(row => ({ alicuota: Number($('[data-k=alicuota]', row).value), neto: numAR($('[data-k=neto]', row).value), iva: numAR($('[data-k=iva]', row).value) }));
  for (const k of ['sin_discriminar', 'no_gravado', 'exento', 'otros_tributos', 'total']) d.importes[k] = numAR(d.importes[k]);
  d.percepciones = $$('[data-perc]', f).map(row => ({ tipo: $('[data-k=tipo]', row).value, jurisdiccion: $('[data-k=jurisdiccion]', row).value || null, importe: numAR($('[data-k=importe]', row).value) }));
  return d;
}

function actualizarCuadre() {
  const box = $('#cuadre');
  if (!box) return;
  const d = leerFormulario();
  let s = 0;
  for (const g of d.importes.gravado) s += g.neto + g.iva;
  s += d.importes.sin_discriminar + d.importes.no_gravado + d.importes.exento + d.importes.otros_tributos;
  for (const p of d.percepciones) s += p.importe;
  s = Math.round(s * 100) / 100;
  const dif = Math.round((s - d.importes.total) * 100) / 100;
  box.innerHTML = `<div class="cuadre ${Math.abs(dif) <= 1 ? 'ok' : 'mal'}"><span>Suma de componentes ${$$m(s)}</span><span>${Math.abs(dif) <= 1 ? 'Cierra' : 'Diferencia ' + $$m(dif)}</span></div>`;
}


async function adminUsuarios(el) {
  const r = await api('/api/usuarios');
  el.innerHTML = `<div class="acciones" style="margin-bottom:12px"><button class="btn btn-negro" id="b-nu">Nuevo usuario</button></div>
    <table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>2FA</th><th>Estado</th><th></th></tr></thead><tbody>
    ${r.usuarios.map(u => `<tr><td>${esc(u.nombre)}</td><td>${esc(u.email)}</td>
      <td><select data-rol="${u.id}">${['escaneo', 'carga', 'aprobador', 'admin'].map(x => `<option ${u.rol === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td>${u.totp_activo ? '<span class="badge b-ok">activo</span>' : '<span class="badge b-aviso">no</span>'}</td>
      <td>${u.activo ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      <td class="acciones"><button class="btn btn-chico" data-pass="${u.id}">Resetear clave</button>${u.totp_activo ? `<button class="btn btn-chico" data-totp="${u.id}">Resetear 2FA</button>` : ''}<button class="btn btn-chico" data-act="${u.id}" data-v="${u.activo ? 0 : 1}">${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')}
    </tbody></table><p class="small muted">Roles: <b>escaneo</b> solo escanea tickets desde el celular y ve lo suyo · <b>carga</b> carga y revisa comprobantes y resúmenes · <b>aprobador</b> además envía a Shares y cierra resúmenes · <b>admin</b> todo, incluida la configuración.</p>`;
  const put = (id, body) => api('/api/usuarios/' + id, { method: 'PUT', body }).then(() => { toast('Guardado'); adminUsuarios(el); }).catch(e => toast(e.message, true));
  $$('[data-rol]', el).forEach(s => s.onchange = () => put(s.dataset.rol, { rol: s.value }));
  $$('[data-act]', el).forEach(b => b.onclick = () => put(b.dataset.act, { activo: b.dataset.v === '1' }));
  $$('[data-totp]', el).forEach(b => b.onclick = async () => await confirmar('¿Resetear el doble factor de este usuario?') && put(b.dataset.totp, { reset_totp: true }));
  $$('[data-pass]', el).forEach(b => b.onclick = async () => { const p = await pedirTexto({ titulo: 'Nueva contraseña', etiqueta: 'Contraseña (mínimo 10 caracteres)', boton: 'Guardar', minimo: 10 }); if (p) put(b.dataset.pass, { password: p }); });
  $('#b-nu', el).onclick = () => modal(`<h2>Nuevo usuario</h2><form id="f-nu">
      <div class="campo"><label>Nombre</label><input name="nombre" required></div>
      <div class="campo"><label>Email</label><input name="email" type="email" required></div>
      <div class="campo"><label>Rol</label><select name="rol"><option>escaneo</option><option selected>carga</option><option>aprobador</option><option>admin</option></select></div>
      <div class="campo"><label>Contraseña inicial</label><input name="password" type="text" minlength="10" required><div class="ayuda">Pasásela por un canal seguro; la puede cambiar en “Mi cuenta”.</div></div>
      <button class="btn btn-negro" type="submit">Crear</button></form>`, {
    alMontar: (m, cerrar) => { $('#f-nu', m).onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/usuarios', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); cerrar(); toast('Usuario creado'); adminUsuarios(el); }); }; },
  });
}


async function adminConfig(el) {
  const r = await api('/api/config');
  const cfg = r.config, def = r.defaults;
  const igual = (k) => JSON.stringify(cfg[k]) === JSON.stringify(def[k]);
  const guardar = async (k, valor, { silencio = false } = {}) => {
    const x = await api('/api/config', { method: 'PUT', body: { clave: k, valor } });
    Object.assign(cfg, x.config);
    if (!silencio) toast(valor === null ? 'Volvió al valor original' : 'Guardado');
    return x;
  };
  const control = (it) => {
    const v = cfg[it.k];
    if (it.tipo === 'switch') return `<label class="switch"><input type="checkbox" data-sw="${it.k}" ${v ? 'checked' : ''} aria-label="${esc(it.t)}"><span></span></label><span class="sw-txt" data-swtxt="${it.k}">${esc(v ? (it.si || 'Activado') : (it.no || 'Apagado'))}</span>`;
    if (it.tipo === 'numero') return `${it.pre ? `<span class="muted">${it.pre}</span>` : ''}<input type="number" data-num="${it.k}" value="${esc(v)}" min="0" step="${it.step || 1}" inputmode="decimal">${it.suf ? `<span class="muted">${it.suf}</span>` : ''}`;
    if (it.tipo === 'opciones') return `<div class="seg" data-op="${it.k}">${it.ops.map(([val, txt]) => `<button type="button" data-v="${val}" class="${v === val ? 'on' : ''}">${txt}</button>`).join('')}</div>`;
    if (it.tipo === 'dia') return `<div class="seg" data-op="${it.k}" data-numerico="1">${DIAS_SEMANA.map(([val, txt]) => `<button type="button" data-v="${val}" class="${String(v) === val ? 'on' : ''}">${txt}</button>`).join('')}</div>`;
    if (it.tipo === 'tel') return `<span class="muted">${ICO.phone}</span><input data-tel="${it.k}" value="${esc(v || '')}" placeholder="5492235123456" inputmode="tel" style="width:190px"><button class="btn btn-chico" data-tel-ok="${it.k}">Guardar</button>`;
    return '';
  };
  const fila = (it) => `<div class="cfg-row" data-fila="${it.k}"><div><div class="t">${esc(it.t)} ${igual(it.k) || it.tipo === 'switch' ? '' : `<button class="btn-link small" data-reset="${it.k}">volver al original</button>`}</div><div class="d">${esc(it.d)}</div></div>
    <div class="cfg-ctrl">${control(it)}</div></div>`;
  el.innerHTML = `${CFG_UI.map(sec => `<section class="cfg-sec"><h3 class="cfg-h">${ICO[sec.ico]}${esc(sec.t)}</h3><div class="panel">${sec.items.map(fila).join('')}</div></section>`).join('')}
    <p class="small muted" style="margin-top:14px">Los cambios se guardan solos y quedan en Auditoría. Los mapeos técnicos de Shares no se tocan desde acá: se cambian con una versión nueva de la app.</p>`;
  const recargar = () => adminConfig(el);

  $$('[data-sw]', el).forEach(c => c.onchange = async () => {
    const it = CFG_UI.flatMap(x => x.items).find(x => x.k === c.dataset.sw);
    const msg = c.checked ? it.confirmarSi : it.confirmarNo;
    if (msg && !await confirmar(msg)) { c.checked = !c.checked; return; }
    try { await guardar(it.k, c.checked); $(`[data-swtxt="${it.k}"]`, el).textContent = c.checked ? (it.si || 'Activado') : (it.no || 'Apagado'); }
    catch (e) { c.checked = !c.checked; toast(e.message, true); }
  });
  $$('[data-num]', el).forEach(i => i.onchange = async () => {
    try { await guardar(i.dataset.num, Number(String(i.value).replace(',', '.'))); }
    catch (e) { i.value = cfg[i.dataset.num]; toast(e.message, true); }
  });
  $$('[data-op]', el).forEach(g => $$('button', g).forEach(b => b.onclick = async () => {
    const val = g.dataset.numerico ? Number(b.dataset.v) : b.dataset.v;
    try { await guardar(g.dataset.op, val); $$('button', g).forEach(x => x.classList.toggle('on', x === b)); }
    catch (e) { toast(e.message, true); }
  }));
  $$('[data-tel-ok]', el).forEach(b => b.onclick = () => conBoton(b, async () => { const i = $(`[data-tel="${b.dataset.telOk}"]`, el); const x = await guardar(b.dataset.telOk, i.value); i.value = x.config[b.dataset.telOk] || ''; }));
  $$('[data-reset]', el).forEach(b => b.onclick = async () => await confirmar('¿Volver al valor original?') && conBoton(b, async () => { await guardar(b.dataset.reset, null); recargar(); }));
}


async function adminAuditoria(el) {
  const r = await api('/api/auditoria');
  el.innerHTML = `<div class="tabla-wrap tabla-scroll" style="max-height:65vh"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Entidad</th><th>Acción</th><th>Campo</th><th>Antes → Después</th></tr></thead><tbody>
    ${r.auditoria.map(a => `<tr><td class="small mono">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${a.entidad === 'factura' ? `<a href="#/factura/${esc(a.entidad_id)}">factura #${esc(a.entidad_id)}</a>` : esc([a.entidad, a.entidad_id].filter(x => x != null && x !== '').join(' ') || '—')}</td><td class="small">${esc(a.accion)}</td><td class="small mono">${esc(a.campo || '')}</td><td class="small mono">${esc(String(a.valor_anterior ?? '').slice(0, 80))} → ${esc(String(a.valor_nuevo ?? '').slice(0, 80))}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------------------------------------------------------------------------
//  Mi cuenta: contraseña y doble factor
// ---------------------------------------------------------------------------

async function vistaMiCuenta(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Mi cuenta</h1><p>${esc(S.user.email)} · rol ${esc(S.user.rol)}</p></div></div>
    ${bloqueInstalar()}
    <div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:12px">Doble factor</h2>
      ${S.user.totp_activo ? '<p><span class="badge b-ok">Activo</span> Te vamos a pedir el código de tu app autenticadora al ingresar.</p>'
      : '<p class="muted">Usá Google Authenticator, Microsoft Authenticator o similar.</p><button class="btn btn-negro" id="b-2fa">Activar doble factor</button><div id="c-2fa"></div>'}
    </div>
    <form class="panel panel-pad" style="max-width:560px" id="f-pass"><h2 style="margin-bottom:12px">Cambiar contraseña</h2>
      <div class="campo"><label>Actual</label><input type="password" name="actual" required autocomplete="current-password"></div>
      <div class="campo"><label>Nueva (mínimo 10 caracteres)</label><input type="password" name="nueva" minlength="10" required autocomplete="new-password"></div>
      <button class="btn btn-negro" type="submit">Cambiar</button></form>`;
  $('#f-pass').onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/yo/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Contraseña cambiada'); }); };
  montarInstalar(el);
  const b = $('#b-2fa');
  if (b) b.onclick = () => conBoton(b, async () => {
    const r = await api('/api/yo/totp/iniciar', { method: 'POST' });
    $('#c-2fa').innerHTML = `<p>1. Escaneá este QR con la app:</p><div id="qr" style="background:#fff;padding:12px;display:inline-block;border-radius:8px"></div>
      <p class="small muted">o cargá la clave a mano: <span class="mono">${esc(r.secret)}</span></p>
      <p>2. Escribí el código de 6 dígitos que muestra la app:</p><div class="fila"><input id="code" inputmode="numeric" maxlength="6" class="mono"><button class="btn btn-negro" id="b-conf">Confirmar</button></div>`;
    if (window.QRCode) new QRCode($('#qr'), { text: r.otpauth, width: 180, height: 180 });
    else $('#qr').textContent = r.otpauth;
    b.remove();
    $('#b-conf').onclick = () => conBoton($('#b-conf'), async () => { await api('/api/yo/totp/confirmar', { method: 'POST', body: { code: $('#code').value } }); S.user.totp_activo = true; toast('Doble factor activado'); vistaMiCuenta(el); });
  });
}


async function copiar(txt) { try { await navigator.clipboard.writeText(txt); toast('Copiado: ' + txt); } catch { toast('No se pudo copiar', true); } }

// ---------------------------------------------------------------------------
//  Motivos de revisión en criollo
// ---------------------------------------------------------------------------
const MOTIVOS = {
  LECTURA: ['No se pudo leer', 'La IA no pudo leerlo: cargá los datos a mano o tocá "Volver a leer".'],
  NO_ES_COMPROBANTE: ['No parece un comprobante', 'Puede ser un remito, presupuesto o el cupón de la tarjeta. Si no corresponde, rechazalo.'],
  SIN_CUIT: ['Falta el CUIT', 'Cargá el CUIT del comercio.'],
  CUIT_INVALIDO: ['CUIT inválido', 'El dígito verificador no cierra: revisalo contra el comprobante.'],
  CUIT_PROPIO: ['Quedó el CUIT de Franchris', 'Franchris es el cliente: cargá el del comercio.'],
  SIN_RAZON: ['Falta el comercio', 'Cargá la razón social del comercio.'],
  SIN_TIPO: ['Falta el tipo', 'Elegí el tipo de comprobante.'],
  TIPO: ['Tipo desconocido', 'Revisá el tipo de comprobante.'],
  SIN_FECHA: ['Falta la fecha', 'Cargá la fecha del comprobante.'],
  FECHA: ['Fecha rara', 'La fecha es futura: revisala.'],
  FECHA_VIEJA: ['Comprobante viejo', 'Revisá el período.'],
  SIN_NUMERO: ['Falta el número', 'Cargá el punto de venta y el número.'],
  SIN_TOTAL: ['Falta el total', 'Cargá el total.'],
  CUADRE: ['No cierra', 'Neto + IVA + percepciones no da el total.'],
  PERC_SIN_CUENTA: ['Percepción sin cuenta', 'No se encontró la cuenta de esa percepción: sincronizá el plan o avisale a Juan.'],
  PERC_NO_GRAVADO: ['Percepción como no gravado', 'Va a la cuenta de percepción de la provincia como no gravado.'],
  IVA_ALICUOTA: ['IVA raro', 'El IVA no coincide con neto × alícuota.'],
  RECEPTOR: ['A nombre de otro', 'La factura A no está a nombre de Franchris.'],
  SIN_CREDITO_FISCAL: ['Sin crédito fiscal', 'B, C o tique a consumidor final.'],
  MONEDA: ['Moneda extranjera', 'Cargá la cotización.'],
  CUENTA: ['Falta la cuenta', 'Elegí el concepto de gasto.'],
  CUENTA_IA: ['Cuenta sugerida por IA', 'Confirmala o elegí otra.'],
  DUPLICADO: ['Duplicado', 'Ya está cargado: rechazá este.'],
  ARCA_RECHAZADO: ['ARCA no lo reconoce', 'El CAE no corresponde: revisalo.'],
  ARCA_ERROR: ['ARCA no respondió', 'No se pudo constatar el CAE.'],
  ARCA_OBSERVADO: ['ARCA con observaciones', ''],
  IA_OBS: ['Observación de la IA', ''],
};
const motivoT = (c) => (MOTIVOS[c] || [c])[0];
function chipsExc(s, max = 2) {
  if (!s) return '';
  const l = String(s).split(',').map(x => x.split(':'));
  const tono = (sev) => sev === 'critica' ? 'b-critica' : 'b-acc';
  return `<div class="chips">${l.slice(0, max).map(([c, sev]) => `<span class="badge ${tono(sev)}">${esc(motivoT(c))}</span>`).join('')}${l.length > max ? `<span class="tag">+${l.length - max}</span>` : ''}</div>`;
}
const MEDIOS = { efectivo: 'Efectivo', tc: 'Tarjeta corporativa' };
const badgeMedio = (m) => `<span class="badge ${m === 'tc' ? 'b-recibida' : 'b-warn'}">${m === 'tc' ? 'Tarjeta' : 'Efectivo'}</span>`;

// ---------------------------------------------------------------------------
//  Versión celular para el rol "escaneo": un botón grande y la lista de lo suyo
// ---------------------------------------------------------------------------
const ESTADO_SIMPLE = { leyendo: 'Leyendo con IA…', error_lectura: 'No se pudo leer', excepcion: 'Recibido', lista: 'Recibido', cargada: 'Cargado', error_shares: 'Recibido', rechazada: 'Rechazado' };
const badgeSimple = (e) => `<span class="badge b-${e === 'rechazada' || e === 'error_lectura' ? 'rechazada' : e === 'cargada' ? 'cargada' : 'lista'}">${esc(ESTADO_SIMPLE[e] || e)}</span>`;

async function vistaEscaneo() {
  const nombre = String(S.user?.nombre || '').split(' ')[0];
  $('#app').innerHTML = `<div class="esc">
    <header class="esc-top"><img class="marca-m" src="logo-negro.png" alt="Lucciano's"><div style="flex:1"></div>
      <button class="ibtn" id="b-tema" aria-label="Cambiar tema">${temaActual() === 'dark' ? ICO.sun : ICO.moon}</button>
      <button class="ibtn" id="b-salir" aria-label="Salir">${ICO.logout}</button></header>
    <main class="esc-main">
      <h1>Hola, ${esc(nombre)}</h1>
      <p class="muted">Sacale una foto al ticket o factura y listo: tesorería se encarga del resto.</p>
      <div class="esc-botones">
        <label class="esc-boton">${ICO.tarjeta}<span>Ticket pagado<br>con tarjeta</span><input type="file" accept="image/*" class="esc-file" data-medio="tc"></label>
        <label class="esc-boton esc-boton-2">${ICO.coin}<span>Ticket pagado<br>en efectivo</span><input type="file" accept="image/*" class="esc-file" data-medio="efectivo"></label>
      </div>
      <div id="esc-subidas"></div>
      ${esStandalone() ? '' : '<div class="esc-instalar" data-instalar></div>'}
      <h2 class="esc-h">Lo que cargaste</h2>
      <div id="esc-lista"><div class="vacio"><span class="cargando"></span></div></div>
      <p class="esc-ver">versión 1.3.3</p>
    </main></div>`;
  $('#b-salir').onclick = () => salir();
  $('#b-tema').onclick = alternarTema;
  // El input va DENTRO del botón y lo toca la persona: es lo único 100% confiable en iPhone
  $$('.esc-file').forEach(inp => inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    const medio = inp.dataset.medio;
    if (f) procesarFotoEscaneo(f, medio);
    setTimeout(() => { inp.value = ''; }, 0);
  }));
  montarInstalar($('#app'));
  pintarSubidas($('#esc-subidas'));
  await pintarMisComprobantes();
}

async function pintarMisComprobantes() {
  const cont = $('#esc-lista'); if (!cont) return;
  clearTimeout(pintarMisComprobantes._t);
  try {
    const { comprobantes } = await api('/api/mis-comprobantes');
    // Mientras haya alguno leyéndose, la lista se actualiza sola
    if (comprobantes.some(c => c.estado === 'leyendo')) pintarMisComprobantes._t = setTimeout(pintarMisComprobantes, 5000);
    cont.innerHTML = comprobantes.length
      ? `<ul class="esc-lista">${comprobantes.map(c => `<li><div><b>${esc(c.razon_social_emisor || 'Comprobante #' + c.id)}</b>
          <small>${fmtFH(c.creado_at)} · ${c.medio_pago === 'tc' ? 'Tarjeta' : 'Efectivo'}${c.estado === 'rechazada' && c.rechazo_motivo ? ' · ' + esc(c.rechazo_motivo) : ''}</small></div>
          <div class="r">${c.total != null ? `<b>${$$m(c.total)}</b>` : ''}${badgeSimple(c.estado)}</div></li>`).join('')}</ul>`
      : '<p class="muted">Todavía no escaneaste nada.</p>';
  } catch (e) { cont.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// ---------------------------------------------------------------------------
//  Cola de subidas: las fotos escaneadas se suben de a una en segundo plano.
//  Quien escanea no espera: saca la foto, toca Procesar y ya puede ir al siguiente ticket.
//  El servidor guarda el archivo y lo lee con Gemini por su cuenta.
// ---------------------------------------------------------------------------
const SUBIDAS = { cola: [], activa: false, n: 0 };
function encolarSubida(blob, medio) {
  if (blob.size > 15e6) { toast('La foto es muy pesada (más de 15 MB).', true); return; }
  SUBIDAS.cola.push({ k: ++SUBIDAS.n, blob, medio, estado: 'subiendo', at: Date.now() });
  avisarSubidas();
  procesarSubidas();
}
async function procesarSubidas() {
  if (SUBIDAS.activa) return;
  SUBIDAS.activa = true;
  try {
    for (;;) {
      const it = SUBIDAS.cola.find(x => x.estado === 'subiendo');
      if (!it) break;
      try {
        const r = await api('/api/comprobantes', { method: 'POST', body: { medio_pago: it.medio, archivo_b64: await blobB64(it.blob), mime: it.blob.type || 'image/jpeg', nombre: 'ticket.jpg' } });
        it.estado = 'ok'; it.cid = r.comprobante.id; it.blob = null;
        if (S.user?.rol !== 'escaneo') toast(`✓ Ticket #${it.cid} recibido: se está leyendo solo`);
      } catch (e) { it.estado = 'error'; it.error = e.message; }
      avisarSubidas();
    }
  } finally { SUBIDAS.activa = false; }
  // Las que ya subieron se sacan de la lista local (aparecen en la lista del servidor)
  setTimeout(() => { SUBIDAS.cola = SUBIDAS.cola.filter(x => x.estado !== 'ok'); avisarSubidas(); }, 4000);
}
function reintentarSubida(k) { const it = SUBIDAS.cola.find(x => x.k === k); if (it && it.blob) { it.estado = 'subiendo'; avisarSubidas(); procesarSubidas(); } }
function descartarSubida(k) { SUBIDAS.cola = SUBIDAS.cola.filter(x => x.k !== k); avisarSubidas(); }
function avisarSubidas() {
  const c = $('#esc-subidas'); if (c) pintarSubidas(c);
  if (SUBIDAS.cola.some(x => x.estado === 'ok') && $('#esc-lista')) pintarMisComprobantes();
}
window.addEventListener('beforeunload', (e) => { if (SUBIDAS.cola.some(x => x.estado === 'subiendo')) { e.preventDefault(); e.returnValue = ''; } });
function pintarSubidas(c) {
  const sub = SUBIDAS.cola.filter(x => x.estado === 'subiendo').length;
  const err = SUBIDAS.cola.filter(x => x.estado === 'error');
  c.innerHTML = (sub ? `<div class="esc-sub"><span class="cargando"></span><span>Subiendo ${sub} ticket${sub > 1 ? 's' : ''}… podés seguir sacando fotos. No cierres la app hasta que termine.</span></div>` : '')
    + err.map(x => `<div class="esc-sub mal">${ICO.alert}<span>No se pudo subir un ticket (${esc(x.error || 'sin conexión')}).</span><button class="btn btn-chico btn-acento" data-reint="${x.k}">Reintentar</button><button class="btn btn-chico" data-desc="${x.k}">Descartar</button></div>`).join('');
  $$('[data-reint]', c).forEach(b => b.onclick = () => reintentarSubida(Number(b.dataset.reint)));
  $$('[data-desc]', c).forEach(b => b.onclick = () => descartarSubida(Number(b.dataset.desc)));
}

function procesarFotoEscaneo(f, medio) {
  const img = new Image();
  img.onload = () => {
    try { montarEscaner(img, (blob) => { encolarSubida(blob, medio); toast('Listo: se sube sola. Podés sacar la siguiente.'); }, () => toast('Tocá de nuevo el botón para sacar otra foto.')); }
    catch (e) { $('#scanner')?.remove(); encolarSubida(f, medio); }
  };
  img.onerror = () => encolarSubida(f, medio);   // si no la puede mostrar, la manda igual
  img.src = URL.createObjectURL(f);
}

// 153 → "2 h 33 min" · 45 → "45 min"
function fmtDuracion(min) {
  min = Math.round(Number(min) || 0);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h${m ? ' ' + m + ' min' : ''}` : `${m} min`;
}

const nroCbteC = (c) => c.numero ? `${String(c.pto_vta ?? 0).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}` : '—';

// ---------------------------------------------------------------------------
//  Login
// ---------------------------------------------------------------------------
// Color de la barra del navegador en el celu (pistacho en el login, el normal adentro)
function colorBarra(c) {
  $$('meta[name="theme-color"]').forEach(m => { if (!m.dataset.orig) m.dataset.orig = m.content; m.content = c || m.dataset.orig; });
}

async function vistaLogin() {
  let setup = false;
  try { setup = (await api('/api/estado')).setup_requerido; } catch (e) {
    $('#app').innerHTML = `<div class="login"><div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><div></div></div>
      <div class="login-form"><div class="caja"><h1>Sin conexión</h1><p>No pude conectar con el servidor (${esc(API)}).<br>${esc(e.message)}</p><button class="btn btn-acento btn-grande" onclick="location.reload()">${ICO.refresh}Reintentar</button></div></div></div>`;
    return;
  }
  $('#app').innerHTML = `<div class="login">
    <div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><p class="login-sub">Gastos con tarjeta y efectivo</p>
      <div class="login-txt"><h2>Los gastos con tarjeta y efectivo, sin tipear.</h2><p>Sacale una foto al ticket o subí la factura: se lee sola, se controla y queda lista para Shares. El resumen de la tarjeta se concilia solo.</p></div>
      <div class="pasos"><span>${ICO.camara}Foto o PDF</span><span>${ICO.sparkle}Se lee sola</span><span>${ICO.tarjeta}Se concilia</span><span>${ICO.send}Va a Shares</span></div></div>
    <div class="login-form"><form id="f-login">
      <h1>${setup ? 'Primer ingreso' : 'Ingresar'}</h1>
      <p>${setup ? 'Creá el usuario administrador.' : "Usá tu mail de Lucciano's."}</p>
      ${setup ? '<div class="campo"><label for="lg-n">Nombre</label><input id="lg-n" name="nombre" required autocomplete="name"></div>' : ''}
      <div class="campo"><label for="lg-u">Mail</label><input id="lg-u" name="email" type="email" required autocomplete="username"></div>
      <div class="campo"><label for="lg-p">Contraseña</label><input id="lg-p" name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 10 : 1}"></div>
      <div class="campo hidden" id="c-totp"><label for="lg-t">Código de verificación</label><input id="lg-t" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" class="mono"></div>
      <button class="btn btn-acento btn-grande" type="submit">${setup ? 'Crear y entrar' : 'Entrar'} ${ICO.arrow}</button>
    </form></div></div>`;
  colorBarra('#A8C686');
  $('#f-login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await conBoton($('button[type=submit]', e.target), async () => {
      const r = await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: fd });
      if (r.requiere_totp) { $('#c-totp').classList.remove('hidden'); $('#c-totp input').focus(); toast('Ingresá el código de tu app autenticadora.'); return; }
      guardarToken(r.token); S.user = r.usuario; colorBarra(null);
      if (!location.hash) location.hash = '#/inicio';
      iniciar();
    });
  };
}

// ---------------------------------------------------------------------------
//  Shell y router
// ---------------------------------------------------------------------------
const RUTAS = [
  { re: /^#\/inicio$/, v: vistaInicio, nav: 'inicio', miga: '<b>Inicio</b>' },
  { re: /^#\/revisar$/, v: (el) => vistaLista(el, 'revisar'), nav: 'revisar', miga: 'Trabajo / <b>Para revisar</b>' },
  { re: /^#\/comprobantes$/, v: (el) => vistaLista(el, 'todos'), nav: 'comprobantes', miga: 'Trabajo / <b>Todos los comprobantes</b>' },
  { re: /^#\/comprobante\/(\d+)$/, v: vistaComprobante, nav: 'revisar', miga: 'Trabajo / <b>Comprobante</b>' },
  { re: /^#\/shares$/, v: vistaShares, nav: 'shares', miga: 'Trabajo / <b>Enviar a Shares</b>' },
  { re: /^#\/resumenes$/, v: vistaResumenes, nav: 'resumenes', miga: 'Tarjeta / <b>Resúmenes</b>' },
  { re: /^#\/resumen\/(\d+)$/, v: vistaResumen, nav: 'resumenes', miga: 'Tarjeta / <b>Conciliación</b>' },
  { re: /^#\/admin$/, v: vistaAdmin, nav: 'admin', miga: 'Datos / <b>Configuración</b>' },
  { re: /^#\/guia$/, v: vistaGuia, nav: 'guia', miga: '<b>Guía de uso</b>' },
  { re: /^#\/cuenta$/, v: vistaMiCuenta, nav: '', miga: '<b>Mi cuenta</b>' },
];

function shell(ruta) {
  const a = ruta.nav;
  const it = (k, ic, t, cnt = '') => `<a href="#/${k}" class="${k === a ? 'activo' : ''}" ${k === a ? 'aria-current="page"' : ''}>${ICO[ic]}<span>${t}</span>${cnt}</a>`;
  const rol = { admin: 'Administrador', aprobador: 'Aprobador', carga: 'Carga' }[S.user.rol] || S.user.rol;
  return `<div class="app">
    <aside class="side">
      <a class="brand" href="#/inicio"><img src="logo-negro.png" alt="Lucciano's"><span>Gastos tarjeta y efectivo</span></a>
      <div class="cargar-side"><button class="btn btn-acento" data-cargar="foto">${ICO.camara}Escanear ticket</button><button class="btn" data-cargar="pdf">${ICO.upload}Subir factura</button></div>
      <nav class="nav" aria-label="Secciones">
        ${it('inicio', 'home', 'Inicio')}
        <div class="grp-t">Trabajo</div>
        ${it('revisar', 'inbox', 'Para revisar', '<span class="cnt hot" data-cnt="revisar"></span>')}
        ${puede('aprobador') ? it('shares', 'send', 'Enviar a Shares', '<span class="cnt" data-cnt="lista"></span>') : ''}
        ${it('comprobantes', 'doc', 'Todos los comprobantes')}
        <div class="grp-t">Tarjeta corporativa</div>
        ${it('resumenes', 'tarjeta', 'Resúmenes y conciliación', '<span class="cnt" data-cnt="conciliar"></span>')}
        <div class="grp-t">Datos</div>
        ${puede('admin') ? it('admin', 'gear', 'Configuración') : ''}
        ${it('guia', 'book', 'Guía de uso')}
      </nav>
      <div class="me"><a class="av" href="#/cuenta" title="Mi cuenta">${esc(iniciales(S.user.nombre))}</a>
        <a class="who" href="#/cuenta"><b>${esc(S.user.nombre)}</b><small>${esc(rol)}</small></a>
        <div class="ibtns"><button class="ibtn" id="b-tema" title="Claro / oscuro" aria-label="Cambiar tema">${temaActual() === 'dark' ? ICO.sun : ICO.moon}</button><button class="ibtn" id="b-salir" title="Salir" aria-label="Salir">${ICO.logout}</button></div></div>
    </aside>
    <div style="min-width:0">
      <header class="top"><img class="marca-m" src="logo-negro.png" alt="Lucciano's"><div class="crumbs">${ruta.miga}</div>
        <label class="buscar">${ICO.search}<input id="buscar-global" placeholder="Buscar comercio, CUIT o #número…" aria-label="Buscar"><kbd>Ctrl K</kbd></label>
        <button class="ibtn" id="b-actualizar" title="Actualizar" aria-label="Actualizar">${ICO.refresh}</button></header>
      <main id="vista" class="entra"><div class="vacio"><span class="cargando"></span></div></main>
    </div></div>
    <nav class="mnav" aria-label="Secciones">
      <a href="#/inicio" class="${a === 'inicio' ? 'activo' : ''}">${ICO.home}Inicio</a>
      <a href="#/revisar" class="${a === 'revisar' ? 'activo' : ''}">${ICO.inbox}Revisar<span class="cnt hot" data-cnt="revisar"></span></a>
      <button class="mnav-cam" data-cargar="foto" aria-label="Escanear ticket">${ICO.camara}</button>
      <a href="#/comprobantes" class="${a === 'comprobantes' ? 'activo' : ''}">${ICO.doc}Todos</a>
      <a href="#/resumenes" class="${a === 'resumenes' ? 'activo' : ''}">${ICO.tarjeta}Tarjeta</a>
    </nav>`;
}

async function contadores(t = null) {
  try {
    if (!t) {
      if (S.cnt && Date.now() - S.cnt.at < 60000) return pintarContadores(S.cnt);
      t = await api('/api/tablero');
    }
    const pe = (k) => t.por_estado?.[k]?.n || 0;
    S.cnt = { at: Date.now(), revisar: pe('excepcion'), lista: pe('lista') + pe('error_shares'), conciliar: (t.resumenes_abiertos || []).reduce((a, r) => a + (r.pendientes || 0), 0) };
    pintarContadores(S.cnt);
  } catch { /* no es crítico */ }
}
function pintarContadores(c) { $$('[data-cnt]').forEach(x => { const n = c[x.dataset.cnt]; x.textContent = n ? n : ''; }); }

async function router() {
  if (!S.token) return vistaLogin();
  if (S.user?.rol === 'escaneo') return vistaEscaneo();
  if (S.pdfUrl) { URL.revokeObjectURL(S.pdfUrl); S.pdfUrl = null; S.pdfBytes = null; }
  const h = location.hash || '#/inicio';
  const r = RUTAS.find(x => x.re.test(h)) || RUTAS[0];
  const m = h.match(r.re) || [];
  $('#app').innerHTML = shell(r);
  $('#b-salir').onclick = () => salir();
  $('#b-tema').onclick = alternarTema;
  $('#b-actualizar').onclick = actualizar;
  $$('[data-cargar]').forEach(b => b.onclick = () => iniciarCarga(b.dataset.cargar));
  const bg = $('#buscar-global');
  bg.onkeydown = (e) => {
    if (e.key !== 'Enter' || !bg.value.trim()) return;
    const q = bg.value.trim();
    if (/^#?\d{1,6}$/.test(q)) { location.hash = '#/comprobante/' + q.replace('#', ''); return; }
    sessionStorage.setItem('cmp_q', q);
    if (location.hash === '#/comprobantes') router(); else location.hash = '#/comprobantes';
  };
  window.scrollTo(0, 0);
  if (r.nav !== 'inicio') contadores();
  try { await r.v($('#vista'), ...m.slice(1)); }
  catch (e) { if (S.token && $('#vista')) { $('#vista').innerHTML = `<div class="panel panel-pad"><h2>No se pudo cargar</h2><p class="muted">${esc(e.message)}</p><button class="btn btn-acento" id="b-reint">${ICO.refresh}Reintentar</button></div>`; $('#b-reint').onclick = router; } }
}

async function iniciar() {
  if (!S.token) return vistaLogin();
  try { const r = await api('/api/yo'); S.user = r.usuario; S.arca = r.arca_modo; } catch { return vistaLogin(); }
  cuentas().catch(() => null);
  await router();
}
window.addEventListener('hashchange', router);
document.addEventListener('DOMContentLoaded', iniciar);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { const b = $('#buscar-global'); if (b) { e.preventDefault(); b.focus(); b.select(); } }
});

// ---------------------------------------------------------------------------
//  Carga: medio de pago → foto (escáner) o PDF → se lee sola
// ---------------------------------------------------------------------------
function elegirMedio(titulo = '¿Cómo se pagó?') {
  return new Promise((resolve) => {
    let listo = false;
    modal(`<h2>${esc(titulo)}</h2>${S.user?.rol === 'escaneo' ? '' : '<p class="muted">Define a qué proveedor va en Shares: efectivo → "No especificado" · tarjeta → "No especificado TC".</p>'}
      <div class="medios"><button class="medio" data-m="tc">${ICO.tarjeta}<b>Tarjeta corporativa</b>${S.user?.rol === 'escaneo' ? '' : '<small>No especificado TC (2186)</small>'}</button>
      <button class="medio" data-m="efectivo">${ICO.coin}<b>Efectivo</b>${S.user?.rol === 'escaneo' ? '' : '<small>No especificado (0)</small>'}</button></div>`, {
      alMontar: (el, cerrar) => {
        $$('[data-m]', el).forEach(b => b.onclick = () => { listo = true; cerrar(); resolve(b.dataset.m); });
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!listo) resolve(null); } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

async function iniciarCarga(tipo, opciones = {}) {
  const medio = opciones.medio || await elegirMedio();
  if (!medio) return;
  if (tipo === 'foto') {
    if (!opciones.movimiento_id && !opciones.alTerminar) return abrirEscaner((blob) => { encolarSubida(blob, medio); toast('Subiendo en segundo plano: podés escanear el siguiente.'); });
    return abrirEscaner((blob) => subirComprobantes([{ blob, nombre: 'ticket.jpg', mime: 'image/jpeg' }], medio, opciones));
  }
  pedirArchivos({ accept: 'application/pdf,image/*', multiple: !opciones.movimiento_id },
    (files) => subirComprobantes(files.map(f => ({ blob: f, nombre: f.name, mime: f.type || 'application/pdf' })), medio, opciones));
}

const blobB64 = (blob) => new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = mal; r.readAsDataURL(blob); });

async function subirComprobantes(archivos, medio, opciones = {}) {
  let cerrar;
  modal(`<h2>${archivos.length === 1 ? 'Leyendo el comprobante' : `Leyendo ${archivos.length} comprobantes`}</h2><p class="muted">Se guarda en Drive y la IA lo lee. Tarda unos segundos.</p><div id="sub-res"></div>`, { alMontar: (el, c) => { cerrar = c; } });
  const res = $('#sub-res');
  let ultimo = null;
  for (const a of archivos) {
    const linea = document.createElement('div');
    linea.className = 'linea-res'; linea.innerHTML = `<span class="cargando"></span>${esc(a.nombre)}`;
    res.appendChild(linea);
    try {
      if (a.blob.size > 15e6) throw new Error('supera 15 MB');
      const r = await api('/api/comprobantes', { method: 'POST', body: { medio_pago: medio, archivo_b64: await blobB64(a.blob), mime: a.mime, nombre: a.nombre, movimiento_id: opciones.movimiento_id || null } });
      ultimo = r.comprobante.id;
      linea.className = 'linea-res bien';
      linea.innerHTML = `${ICO.check}<span>${esc(r.datos?.emisor?.razon_social || a.nombre)} · ${$$m(r.datos?.importes?.total)} → <a href="#/comprobante/${r.comprobante.id}">#${r.comprobante.id}</a> ${badgeEstado(r.comprobante.estado)}</span>`;
    } catch (e) { linea.className = 'linea-res mal'; linea.innerHTML = `${ICO.x}<span>${esc(a.nombre)}: ${esc(e.message)}</span>`; }
  }
  S.cnt = null;
  if (archivos.length === 1 && ultimo) { cerrar(); if (opciones.alTerminar) opciones.alTerminar(ultimo); else location.hash = '#/comprobante/' + ultimo; }
  else { res.insertAdjacentHTML('beforeend', '<div class="acciones" style="margin-top:12px"><a class="btn btn-acento" href="#/revisar">Ir a Para revisar</a></div>'); if (opciones.alTerminar) opciones.alTerminar(null); else if (location.hash === '#/revisar' || location.hash === '#/comprobantes') router(); }
}

// Selector de archivos. El input tiene que estar DENTRO de la página: en iPhone, si queda suelto,
// el navegador a veces lo descarta mientras la cámara está abierta y nunca avisa que se sacó la foto.
function pedirArchivos({ accept, multiple = false }, alElegir) {
  $$('input[data-picker]').forEach(x => x.remove());
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = accept; inp.multiple = multiple; inp.dataset.picker = '1';
  inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(inp);
  let hecho = false;
  const listo = () => {
    if (hecho) return;
    const files = [...(inp.files || [])];
    if (!files.length) return;
    hecho = true; inp.remove();
    try { alElegir(files); } catch (e) { toast('Algo falló: ' + e.message, true); }
  };
  inp.addEventListener('change', listo);
  inp.addEventListener('input', listo);
  inp.click();
}

// ---- Escáner de tickets (el mismo de Viáticos: cámara nativa → esquinas → perspectiva → gris) ----
function abrirEscaner(alListo) {
  // sin 'capture': en iPhone ofrece "Tomar foto / Fototeca" y no repite el permiso
  pedirArchivos({ accept: 'image/*' }, ([f]) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      try { montarEscaner(img, alListo, () => abrirEscaner(alListo)); }
      catch (e) {
        // Si el recorte falla, se manda la foto tal cual: mejor eso que perderla
        $('#scanner')?.remove();
        toast('No pude recortar la foto, la mando entera.');
        alListo(f);
      }
    };
    img.onerror = () => { toast('No pude abrir esa foto. Probá sacarla de nuevo.', true); };
    img.src = url;
  });
}

function montarEscaner(rawImg, alListo, otraFoto) {
  const ov = document.createElement('section');
  ov.id = 'scanner';
  ov.innerHTML = `<div class="scan-top"><button class="scan-side" id="scan-cancel">Cancelar</button><div class="st-title">Ajustá el recuadro</div><div class="scan-side"></div></div>
    <div class="scan-stage" id="scan-stage"><canvas id="scan-canvas"></canvas><div class="scan-hint">Arrastrá las esquinas para encuadrar el comprobante</div></div>
    <div class="scan-bar"><button class="scan-side" id="scan-retry">Otra foto</button><div style="flex:1"></div><button class="btn btn-acento" id="scan-ok">Procesar</button></div>`;
  document.body.appendChild(ov);
  const C = $('#scan-canvas', ov), stage = $('#scan-stage', ov);
  const cerrar = () => ov.remove();
  $('#scan-cancel', ov).onclick = cerrar;
  $('#scan-retry', ov).onclick = () => { cerrar(); otraFoto(); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const scale = Math.min(stage.clientWidth / rawImg.width, stage.clientHeight / rawImg.height, 1);
  C.width = rawImg.width * scale; C.height = rawImg.height * scale;
  const cctx = C.getContext('2d');
  cctx.drawImage(rawImg, 0, 0, C.width, C.height);
  let corners = autoDetectarDocumento(cctx, C.width, C.height);
  if (!corners) { const ix = C.width * .08, iy = C.height * .08; corners = [{ x: ix, y: iy }, { x: C.width - ix, y: iy }, { x: C.width - ix, y: C.height - iy }, { x: ix, y: C.height - iy }]; }
  const PARES = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const cEls = corners.map(() => { const e = document.createElement('div'); e.className = 'corner'; stage.appendChild(e); return e; });
  const eEls = PARES.map(() => { const e = document.createElement('div'); e.className = 'edge-handle'; stage.appendChild(e); return e; });
  const dibujar = () => {
    const rect = C.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const ox = rect.left - sr.left, oy = rect.top - sr.top;
    corners.forEach((c, i) => { cEls[i].style.left = (ox + c.x) + 'px'; cEls[i].style.top = (oy + c.y) + 'px'; });
    PARES.forEach(([i, j], k) => { eEls[k].style.left = (ox + (corners[i].x + corners[j].x) / 2) + 'px'; eEls[k].style.top = (oy + (corners[i].y + corners[j].y) / 2) + 'px'; });
    cctx.drawImage(rawImg, 0, 0, C.width, C.height);
    cctx.strokeStyle = '#fff'; cctx.lineWidth = 2; cctx.fillStyle = 'rgba(255,255,255,.12)';
    cctx.beginPath(); corners.forEach((c, i) => i ? cctx.lineTo(c.x, c.y) : cctx.moveTo(c.x, c.y)); cctx.closePath(); cctx.fill(); cctx.stroke();
  };
  const arrastre = (el, mover) => el.addEventListener('pointerdown', ev => {
    ev.preventDefault(); el.setPointerCapture(ev.pointerId);
    const ini = { x: ev.clientX, y: ev.clientY, c: corners.map(c => ({ ...c })) }, rect = C.getBoundingClientRect();
    const mv = e => { mover(e, ini, rect); dibujar(); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  cEls.forEach((el, i) => arrastre(el, (e, ini, rect) => { corners[i] = { x: clamp(e.clientX - rect.left, 0, C.width), y: clamp(e.clientY - rect.top, 0, C.height) }; }));
  eEls.forEach((el, k) => arrastre(el, (e, ini) => {
    const [i, j] = PARES[k], dx = e.clientX - ini.x, dy = e.clientY - ini.y;
    corners[i] = { x: clamp(ini.c[i].x + dx, 0, C.width), y: clamp(ini.c[i].y + dy, 0, C.height) };
    corners[j] = { x: clamp(ini.c[j].x + dx, 0, C.width), y: clamp(ini.c[j].y + dy, 0, C.height) };
  }));
  requestAnimationFrame(dibujar);
  $('#scan-ok', ov).onclick = () => {
    $('#scan-ok', ov).disabled = true; $('#scan-ok', ov).innerHTML = '<span class="cargando"></span>';
    setTimeout(() => {
      const blobPromesa = recortarPerspectiva(rawImg, C, corners);
      blobPromesa.then(blob => { cerrar(); alListo(blob); }).catch(e => { toast('No se pudo procesar la foto: ' + e.message, true); cerrar(); });
    }, 30);
  };
}

// El ticket es la zona más clara: franja ancha de píxeles claros por fila y columna
function autoDetectarDocumento(ctx, w, h) {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    const br = new Float32Array(w * h); let maxB = 0;
    for (let i = 0, j = 0; i < data.length; i += 4, j++) { const v = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114; br[j] = v; if (v > maxB) maxB = v; }
    if (maxB < 40) return null;
    const th = maxB * .7, rc = new Float32Array(h), cc = new Float32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (br[y * w + x] > th) { rc[y]++; cc[x]++; }
    const F = .22; let t = 0, b = h - 1, l = 0, r = w - 1;
    while (t < h && rc[t] / w < F) t++; while (b > 0 && rc[b] / w < F) b--;
    while (l < w && cc[l] / h < F) l++; while (r > 0 && cc[r] / h < F) r--;
    if (b - t < h * .15 || r - l < w * .15) return null;
    const mx = (r - l) * .03, my = (b - t) * .03;
    return [{ x: Math.max(0, l - mx), y: Math.max(0, t - my) }, { x: Math.min(w, r + mx), y: Math.max(0, t - my) }, { x: Math.min(w, r + mx), y: Math.min(h, b + my) }, { x: Math.max(0, l - mx), y: Math.min(h, b + my) }];
  } catch { return null; }
}

function resolver8(A, b) {
  const n = 8, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function homografia(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) { const { x, y } = src[i], { x: X, y: Y } = dst[i]; A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X); A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y); }
  const h = resolver8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
function inversa3(m) {
  const [a, b, c, d, e, f, g, h, i] = m, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
// Recorte con corrección de perspectiva (muestreo bilineal) + filtro gris de contraste. Lado máximo 3000 px.
function recortarPerspectiva(rawImg, C, corners) {
  const MAX = 3000, esc = Math.min(1, MAX / Math.max(rawImg.width, rawImg.height));
  const wW = Math.round(rawImg.width * esc), wH = Math.round(rawImg.height * esc);
  const wc = document.createElement('canvas'); wc.width = wW; wc.height = wH;
  wc.getContext('2d').drawImage(rawImg, 0, 0, wW, wH);
  const sx = wW / C.width, sy = wH / C.height;
  const src = corners.map(c => ({ x: c.x * sx, y: c.y * sy }));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const W = Math.round((dist(src[0], src[1]) + dist(src[3], src[2])) / 2), H = Math.round((dist(src[0], src[3]) + dist(src[1], src[2])) / 2);
  const Hi = inversa3(homografia(src, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]));
  const sd = wc.getContext('2d').getImageData(0, 0, wW, wH).data;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d'), od0 = octx.createImageData(W, H), od = od0.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dz = Hi[6] * x + Hi[7] * y + Hi[8], ux = (Hi[0] * x + Hi[1] * y + Hi[2]) / dz, uy = (Hi[3] * x + Hi[4] * y + Hi[5]) / dz, oi = (y * W + x) * 4;
    if (ux >= 0 && uy >= 0 && ux < wW - 1 && uy < wH - 1) {
      const x0 = ux | 0, y0 = uy | 0, fx = ux - x0, fy = uy - y0, i00 = (y0 * wW + x0) * 4, i10 = i00 + 4, i01 = i00 + wW * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) { const t = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx, b = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx; od[oi + c] = (t * (1 - fy) + b * fy) + .5 | 0; }
      od[oi + 3] = 255;
    } else { od[oi] = od[oi + 1] = od[oi + 2] = 255; od[oi + 3] = 255; }
  }
  let mn = 255, mx = 0;
  for (let i = 0; i < od.length; i += 4) { const v = .299 * od[i] + .587 * od[i + 1] + .114 * od[i + 2]; od[i] = od[i + 1] = od[i + 2] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const rng = Math.max(1, mx - mn);
  for (let i = 0; i < od.length; i += 4) { const v = Math.min(255, Math.max(0, (od[i] - mn) * 255 / rng * 1.08)); od[i] = od[i + 1] = od[i + 2] = v; }
  octx.putImageData(od0, 0, 0);
  return new Promise((ok, mal) => out.toBlob(b => b ? ok(b) : mal(new Error('sin imagen')), 'image/jpeg', .9));
}

// ---------------------------------------------------------------------------
//  Inicio
// ---------------------------------------------------------------------------
async function vistaInicio(el) {
  const t = await api('/api/tablero');
  contadores(t);
  const pe = (k) => t.por_estado[k] || { n: 0, monto: 0 };
  const hora = new Date().getHours();
  const saludo = hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
  const mm = t.mes_por_medio || {};
  const pend = (t.resumenes_abiertos || []).reduce((a, r) => a + (r.pendientes || 0), 0);
  el.innerHTML = `<div class="encabezado"><div><h1>${saludo}, ${esc(String(S.user.nombre).split(' ')[0])}</h1><p>Cargá los comprobantes de gastos pagados con la tarjeta corporativa o en efectivo.</p></div></div>
    <div class="cargas">
      <button class="carga" data-c="foto">${ICO.camara}<b>Escanear ticket</b><small>Con la cámara del celular</small></button>
      <button class="carga" data-c="pdf">${ICO.upload}<b>Subir factura</b><small>PDF o foto, uno o varios</small></button>
      <a class="carga" href="#/resumenes">${ICO.tarjeta}<b>Resumen de la tarjeta</b><small>Subilo y se concilia solo</small></a>
    </div>
    <div class="kpis">
      <a class="kpi ${pe('excepcion').n ? 'alerta' : ''}" href="#/revisar"><div class="et">Para revisar</div><div class="val">${pe('excepcion').n}</div><div class="sub">${$$corto(pe('excepcion').monto)}</div></a>
      <a class="kpi ${pe('lista').n ? 'ok' : ''}" href="${puede('aprobador') ? '#/shares' : '#/comprobantes'}"><div class="et">Listos para Shares</div><div class="val">${pe('lista').n}</div><div class="sub">${$$corto(pe('lista').monto)}</div></a>
      <div class="kpi"><div class="et">Este mes · tarjeta</div><div class="val">${$$corto(mm.tc?.monto || 0)}</div><div class="sub">${mm.tc?.n || 0} comprobante(s)</div></div>
      <div class="kpi"><div class="et">Este mes · efectivo</div><div class="val">${$$corto(mm.efectivo?.monto || 0)}</div><div class="sub">${mm.efectivo?.n || 0} comprobante(s)</div></div>
      ${t.ahorro ? `<div class="kpi" title="Cada comprobante cargado en Shares con la app suma ${String(t.ahorro.minutos_por_comprobante).replace('.', ',')} min (se cambia en Configuración → Ajustes)"><div class="et">Tiempo ahorrado</div><div class="val">${fmtDuracion(t.ahorro.cargados_mes * t.ahorro.minutos_por_comprobante)}</div>
        <div class="sub">este mes · ${fmtDuracion(t.ahorro.cargados_total * t.ahorro.minutos_por_comprobante)} desde el inicio<br>~${String(t.ahorro.minutos_por_comprobante).replace('.', ',')} min por comprobante cargado</div></div>` : ''}
    </div>
    <div class="dos">
      <div class="panel"><div class="panel-titulo"><h2>Conciliación de la tarjeta</h2><a class="btn btn-ghost btn-chico" href="#/resumenes">Ver resúmenes</a></div>
        ${t.resumenes_abiertos.length ? `<ul class="hist pad">${t.resumenes_abiertos.map(r => `<li><a href="#/resumen/${r.id}"><b>${esc([r.banco, r.tarjeta].filter(Boolean).join(' · ') || 'Resumen')}</b> cierre ${fmtF(r.fecha_cierre)}</a> — ${r.pendientes ? `<span class="txt-neg">${r.pendientes} consumo(s) sin comprobante</span>` : 'todo conciliado'} de ${r.consumos}</li>`).join('')}</ul>`
        : '<div class="vacio">No hay resúmenes abiertos. Cuando llegue el de la tarjeta, subilo en "Resúmenes".</div>'}
        ${pend ? '' : ''}</div>
      <div class="panel"><div class="panel-titulo"><h2>Últimos cargados</h2><a class="btn btn-ghost btn-chico" href="#/comprobantes">Ver todos</a></div>
        ${t.ultimos.length ? `<ul class="feed">${t.ultimos.map(c => `<li data-id="${c.id}" tabindex="0">${cuad(nombreProv(c))}<div style="min-width:0"><div class="t">${esc(nombreProv(c))}</div><div class="d">${badgeMedio(c.medio_pago)} ${fmtF(c.fecha_emision)}</div></div>
          <div class="r"><b>${$$m(c.total)}</b>${badgeEstado(c.estado)}</div></li>`).join('')}</ul>` : '<div class="vacio">Todavía no se cargó nada.</div>'}</div>
    </div>`;
  $$('[data-c]', el).forEach(b => b.onclick = () => iniciarCarga(b.dataset.c));
  $$('.feed li', el).forEach(li => li.onclick = () => { location.hash = '#/comprobante/' + li.dataset.id; });
}

// ---------------------------------------------------------------------------
//  Listas: Para revisar y Todos
// ---------------------------------------------------------------------------
async function vistaLista(el, modo) {
  const revisar = modo === 'revisar';
  let medio = sessionStorage.getItem('cmp_medio') || '';
  let estado = revisar ? 'excepcion,error_lectura,leyendo' : (sessionStorage.getItem('cmp_estado') || '');
  const q0 = sessionStorage.getItem('cmp_q') || ''; sessionStorage.removeItem('cmp_q');
  el.innerHTML = `<div class="encabezado"><div><h1>${revisar ? 'Para revisar' : 'Todos los comprobantes'}</h1><p>${revisar ? 'Lo que necesita una persona: falta un dato, la cuenta o algo no cierra.' : 'Todo lo cargado, con el archivo original a un clic.'}</p></div>
      <div class="acciones">${revisar ? '' : `<button class="btn" id="b-csv">${ICO.doc}Exportar CSV</button>`}<button class="btn btn-negro" data-cargar2="pdf">${ICO.upload}Subir factura</button></div></div>
    <div class="panel"><div class="cola-bar"><label class="campo-buscar">${ICO.search}<input id="q" placeholder="Comercio, CUIT, número o #id" value="${esc(q0)}"></label>
      <div class="seg" id="seg-medio" style="margin:0">${[['', 'Todos'], ['tc', 'Tarjeta'], ['efectivo', 'Efectivo']].map(([k, t]) => `<button data-m="${k}" class="${k === medio ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${revisar ? '' : `<select id="f-estado" style="max-width:200px"><option value="">Todos los estados</option>${Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}" ${estado === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`}</div>
      <div class="tabla-wrap"><table class="tabla-comps"><thead><tr><th>Comercio</th><th>Estado</th><th>Medio</th><th>Comprobante</th><th>Fecha</th><th class="num">Total</th><th>${revisar ? 'Qué falta' : 'Cuenta'}</th></tr></thead><tbody id="tb"><tr><td colspan="7" class="vacio"><span class="cargando"></span></td></tr></tbody></table></div></div>`;
  $$('[data-cargar2]', el).forEach(b => b.onclick = () => iniciarCarga(b.dataset.cargar2));
  let datos = [];
  const cargar = async () => {
    const p = new URLSearchParams({ limite: 300 });
    if (estado) p.set('estado', estado);
    if (medio) p.set('medio', medio);
    if ($('#q').value.trim()) p.set('q', $('#q').value.trim());
    const r = await api('/api/comprobantes?' + p);
    datos = r.comprobantes;
    $('#tb').innerHTML = datos.length ? datos.map(c => `<tr class="click" data-id="${c.id}">
      <td><div class="prov">${cuad(nombreProv(c))}<div><b>${esc(nombreProv(c))}</b><small class="mono">${c.cuit_emisor ? fmtCuit(c.cuit_emisor) + ' · ' : ''}#${c.id}</small></div></div></td>
      <td>${badgeEstado(c.estado)}<small class="sub-celda">${fmtFH(c.creado_at)} · ${esc(String(c.creado_por || '').split('@')[0])}</small></td>
      <td>${badgeMedio(c.medio_pago)}${c.resumen_id ? `<small class="sub-celda">en resumen</small>` : ''}</td>
      <td class="mono">${esc(TIPOS[c.tipo_cbte_arca] || '')} ${nroCbteC(c)}</td>
      <td class="mono">${fmtF(c.fecha_emision)}</td>
      <td class="num"><b>${c.moneda && c.moneda !== 'PES' ? esc(c.moneda) + ' ' : ''}${$$m(c.total)}</b></td>
      <td class="celda-motivos">${c.estado === 'rechazada' && c.rechazo_motivo ? `<div class="small muted motivo-rech">${esc(c.rechazo_motivo)}</div>` : revisar || c.excepciones ? chipsExc(c.excepciones) : `<span class="small">${esc(c.cuenta ? c.cuenta + ' ' + (c.cuenta_denominacion || '') : '—')}</span>`}</td></tr>`).join('')
      : `<tr><td colspan="7" class="vacio">${revisar ? '<span class="grande">Nada para revisar</span>Todo lo cargado pasó los controles.' : 'No hay comprobantes.'}</td></tr>`;
    $$('#tb tr[data-id]').forEach(tr => tr.onclick = () => { location.hash = '#/comprobante/' + tr.dataset.id; });
  };
  let t0; $('#q').oninput = () => { clearTimeout(t0); t0 = setTimeout(cargar, 300); };
  $$('#seg-medio button').forEach(b => b.onclick = () => { medio = b.dataset.m; sessionStorage.setItem('cmp_medio', medio); $$('#seg-medio button').forEach(x => x.classList.toggle('on', x === b)); cargar(); });
  const fe = $('#f-estado'); if (fe) fe.onchange = () => { estado = fe.value; sessionStorage.setItem('cmp_estado', estado); cargar(); };
  const bc = $('#b-csv'); if (bc) bc.onclick = () => descargarCsv(`comprobantes_${new Date().toISOString().slice(0, 10)}.csv`, [
    ['ID', 'Estado', 'Medio', 'CUIT', 'Comercio', 'Tipo', 'Número', 'Fecha', 'Moneda', 'Total', 'Cuenta', 'Denominación', 'Ref. Shares', 'Cargado por', 'Cargado'],
    ...datos.map(c => [c.id, ESTADOS[c.estado] || c.estado, MEDIOS[c.medio_pago], c.cuit_emisor || '', c.razon_social_emisor || '', TIPOS[c.tipo_cbte_arca] || '', nroCbteC(c), c.fecha_emision || '', c.moneda || 'PES', String(c.total ?? '').replace('.', ','), c.cuenta || '', c.cuenta_denominacion || '', c.shares_ref || '', c.creado_por || '', c.creado_at || '']),
  ]);
  await cargar();
}

// ---------------------------------------------------------------------------
//  Detalle de un comprobante
// ---------------------------------------------------------------------------
async function vistaComprobante(el, id) {
  await cuentas().catch(() => null);
  const r = await api('/api/comprobantes/' + id);
  pintarComprobante(el, r);
  if (r.comprobante.estado === 'leyendo') {
    const h = location.hash;
    const mirar = async () => {
      if (!el.isConnected || location.hash !== h) return;
      const n = await api('/api/comprobantes/' + id).catch(() => null);
      if (!el.isConnected || location.hash !== h) return;
      if (n && n.comprobante.estado !== 'leyendo') { pintarComprobante(el, n); toast('Listo: ya se leyó'); return; }
      setTimeout(mirar, 4000);
    };
    setTimeout(mirar, 4000);
  }
}

function pintarComprobante(el, r) {
  const f = r.comprobante, d = r.datos || vacioDatos(), c = d.comprobante || {}, im = d.importes || {};
  const editable = ['excepcion', 'lista', 'error_shares', 'error_lectura'].includes(f.estado);
  const dis = editable ? '' : 'disabled';
  const inp = (name, val, extra = '') => `<input name="${name}" value="${esc(val ?? '')}" ${dis} ${extra}>`;
  const abiertas = r.excepciones.filter(e => !e.resuelta && e.severidad !== 'aviso');
  const avisos = r.excepciones.filter(e => !e.resuelta && e.severidad === 'aviso');
  const nombre = d.emisor?.razon_social || 'Comprobante';
  const bots = [];
  if (editable) bots.push(['b-ok', `${ICO.check}Guardar y controlar`, 'btn-acento principal']);
  if (f.estado === 'lista' && puede('aprobador')) bots.push(['b-enviar', `${ICO.send}Enviar a Shares`, 'btn-negro']);
  if (f.estado === 'error_shares' && puede('aprobador')) bots.push(['b-enviar', `${ICO.send}Reintentar envío`, 'btn-negro']);
  if (editable) bots.push(['b-releer', `${ICO.refresh}Volver a leer`, '']);
  if (editable) bots.push(['b-rechazar', 'Rechazar', 'btn-rojo']);
  if (f.estado === 'rechazada') bots.push(['b-reabrir', `${ICO.refresh}Reabrir`, '']);
  el.innerHTML = `
  <div class="encabezado" style="margin-bottom:16px"><div class="navfact"><a class="btn btn-ghost btn-chico" href="#/revisar">${ICO.back}Para revisar</a><span class="tag mono">#${f.id}</span></div></div>
  <div class="detalle">
    <div class="visor" id="visor"><div class="vacio"><span><span class="cargando"></span> Cargando…</span></div></div>
    <div class="lado">
      <section class="panel ficha">
        <div class="fila1">${badgeEstado(f.estado)}${badgeMedio(f.medio_pago)}<span class="tag">${f.origen === 'foto' ? ICO.camara + 'Foto' : ICO.doc + 'PDF'}</span></div>
        <h2>${esc(nombre)}</h2>
        <div class="meta"><span class="mono">${fmtCuit(d.emisor?.cuit)}</span><span>${esc(TIPOS[c.tipo_arca] || 'Comprobante')} ${c.numero ? nroCbteC({ pto_vta: c.pto_vta, numero: c.numero }) : ''}</span>${c.fecha_emision ? `<span>${fmtF(c.fecha_emision)}</span>` : ''}
          <span>Cargado por ${esc(String(f.creado_por || '').split('@')[0])} · ${fmtFH(f.creado_at)}</span>${f.shares_ref ? `<span>Ref. Shares <b class="mono">${esc(f.shares_ref)}</b></span>` : ''}</div>
        <div class="total"><b>${im.total ? (c.moneda && c.moneda !== 'PES' ? esc(c.moneda) + ' ' : '') + $$m(im.total) : '—'}</b>
          <span class="tag">${ICO.users}Shares: proveedor ${esc(r.proveedor_shares ? r.proveedor_shares.codigo + ' · ' + r.proveedor_shares.nombre : '—')}</span></div>
        ${r.movimiento ? `<p class="small" style="margin:8px 0 0">${ICO.tarjeta} Conciliado con el consumo "${esc(r.movimiento.descripcion)}" del <a href="#/resumen/${r.movimiento.resumen_id}">resumen ${esc(r.movimiento.banco || '')} cierre ${fmtF(r.movimiento.fecha_cierre)}</a></p>` : ''}
        ${f.estado === 'rechazada' ? `<p class="small txt-neg">Rechazado: ${esc(f.rechazo_motivo || '')}</p>` : ''}
      </section>
      ${f.estado === 'leyendo' ? `<section class="tarea"><div class="panel-titulo"><h2>Leyéndose con IA</h2><span class="cargando"></span></div><div class="cuerpo"><p class="small">Se está leyendo en segundo plano: en unos segundos aparecen los datos solos. Mientras tanto podés seguir con otra cosa.</p></div></section>` : ''}
      ${abiertas.length ? `<section class="tarea"><div class="panel-titulo"><h2>Qué falta</h2><span class="badge b-acc">${abiertas.length}</span></div><div class="cuerpo">
        ${abiertas.map(e => `<div class="excepcion ${e.severidad}"><div class="txt"><b>${esc(motivoT(e.codigo))}</b><br>${esc(e.mensaje)}</div>
          ${editable && !['CUENTA', 'SIN_CUIT', 'SIN_RAZON', 'SIN_TOTAL', 'SIN_FECHA', 'SIN_TIPO'].includes(e.codigo) && (e.severidad !== 'critica' || puede('admin')) ? `<button class="btn btn-chico" data-aceptar="${esc(e.codigo)}">${e.codigo === 'CUENTA_IA' ? 'Confirmar cuenta' : 'Aceptar igual'}</button>` : ''}</div>`).join('')}</div></section>`
      : f.estado === 'lista' ? `<section class="tarea bien"><div class="panel-titulo"><h2>Todo en orden</h2><span class="badge b-ok">Listo para Shares</span></div></section>` : ''}
      ${avisos.length ? `<section class="panel panel-pad small">${avisos.map(e => `<div class="con-ico muted">${ICO.info}${esc(e.mensaje)}</div>`).join('')}</section>` : ''}
      <section class="panel">
      <div class="tabs" id="tabs"><button class="activo" data-tab="datos">Datos</button><button data-tab="shares">Cómo va a Shares</button><button data-tab="hist">Historial</button></div>
      <form id="f-datos" class="tab" data-tab="datos" autocomplete="off">
        <div class="seccion"><h3>Pago y concepto</h3>
          <div class="fila"><div class="campo"><label>Medio de pago</label><div class="seg" id="seg-medio" style="margin:0">${[['tc', 'Tarjeta corporativa'], ['efectivo', 'Efectivo']].map(([k, t]) => `<button type="button" data-m="${k}" class="${f.medio_pago === k ? 'on' : ''}" ${dis}>${t}</button>`).join('')}</div></div></div>
          ${datalistCuentas()}
          <div class="fila">
            <div class="campo"><label>Concepto de gasto (cuenta)</label><input name="imputacion.codigo_concepto" list="dl-cuentas" class="mono" value="${esc(d.imputacion?.codigo_concepto || '')}" ${dis} placeholder="Buscá por código o nombre"></div>
            <div class="campo" style="grid-column: span 2"><label>Denominación</label><input id="den-cuenta" disabled value="${esc(r.cuenta?.denominacion || nombreCuenta(d.imputacion?.codigo_concepto))}"></div>
          </div>
          <p class="ayuda">${d.imputacion?.origen ? 'Origen: <b>' + esc({ comercio: 'la misma que la vez anterior para este comercio', ia: 'sugerida por la IA — confirmala', manual: 'elegida por una persona' }[d.imputacion.origen] || d.imputacion.origen) + '</b>' + (d.imputacion.detalle && d.imputacion.origen !== 'comercio' ? ' · ' + esc(d.imputacion.detalle) : '') : 'Elegí la cuenta: la app la recuerda para la próxima vez de este comercio.'}${d.detalle_resumen ? ` · <b>Qué se compró:</b> ${esc(d.detalle_resumen)}` : ''}</p>
          <div class="campo"><label>Nota (opcional)</label><input id="nota" value="${esc(f.nota || '')}" ${dis} placeholder="Ej.: almuerzo con proveedores, viaje a CABA"></div>
        </div>
        <div class="seccion"><h3>Comercio</h3>
          <div class="fila">
            <div class="campo"><label>CUIT</label>${inp('emisor.cuit', d.emisor?.cuit, 'class="mono" inputmode="numeric"')}</div>
            <div class="campo" style="grid-column: span 2"><label>Razón social</label>${inp('emisor.razon_social', d.emisor?.razon_social)}</div>
          </div>
        </div>
        <div class="seccion"><h3>Comprobante</h3>
          <div class="fila">
            <div class="campo"><label>Tipo</label><select name="comprobante.tipo_arca" ${dis}><option value="">—</option>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${String(c.tipo_arca) === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="campo"><label>Punto de venta</label>${inp('comprobante.pto_vta', c.pto_vta, 'inputmode="numeric" class="mono"')}</div>
            <div class="campo"><label>Número</label>${inp('comprobante.numero', c.numero, 'inputmode="numeric" class="mono"')}</div>
          </div>
          <div class="fila">
            <div class="campo"><label>Fecha</label><input type="date" name="comprobante.fecha_emision" value="${esc(c.fecha_emision || '')}" ${dis}></div>
            <div class="campo"><label>Moneda</label><select name="comprobante.moneda" ${dis}>${['PES', 'DOL', 'EUR'].map(x => `<option ${c.moneda === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            <div class="campo"><label>Cotización</label>${inp('comprobante.cotizacion', c.cotizacion || '', 'class="num" placeholder="solo si no es en pesos"')}</div>
          </div>
          <div class="fila"><div class="campo" style="grid-column: span 3"><label>CAE (si tiene)</label>${inp('comprobante.cae', c.cae, 'class="mono" inputmode="numeric"')}</div></div>
        </div>
        <div class="seccion"><h3>Importes</h3>
          <div class="grid-items small muted"><span>Alícuota</span><span>Neto gravado</span><span>IVA</span><span></span></div>
          <div id="gravado">${(im.gravado || []).map(filaGravado).join('')}</div>
          ${editable ? '<button type="button" class="btn btn-ghost btn-chico" id="add-grav">+ Alícuota</button>' : ''}
          <div class="fila" style="margin-top:12px">
            <div class="campo"><label>Sin IVA discriminado</label>${inp('importes.sin_discriminar', im.sin_discriminar || '', 'class="num"')}</div>
            <div class="campo"><label>No gravado / exento</label>${inp('importes.no_gravado', r2v(num0(im.no_gravado) + num0(im.exento)) || '', 'class="num"')}</div>
            <div class="campo"><label>Otros tributos</label>${inp('importes.otros_tributos', im.otros_tributos || '', 'class="num"')}</div>
          </div>
          <h3 style="margin:8px 0">Percepciones</h3>
          <div class="grid-perc small muted"><span>Tipo</span><span>Jurisdicción</span><span>Importe</span><span></span></div>
          <div id="percepciones">${(d.percepciones || []).map(filaPercepcion).join('')}</div>
          ${editable ? '<button type="button" class="btn btn-ghost btn-chico" id="add-perc">+ Percepción</button>' : ''}
          <div class="fila" style="margin-top:12px"><div class="campo"><label>TOTAL</label>${inp('importes.total', im.total || '', 'class="num" style="font-weight:700"')}</div></div>
          <div id="cuadre"></div>
        </div>
      </form>
      <div class="tab hidden" data-tab="shares"><div class="seccion">
        ${r.shares_enviado ? `<h3>Enviado a Shares</h3><pre class="json">${esc(JSON.stringify(r.shares_enviado, null, 2))}</pre><h3 style="margin-top:12px">Respuesta</h3><pre class="json">${esc(JSON.stringify(r.shares_respuesta, null, 2))}</pre>`
        : r.shares_preview ? `<h3>Así se va a enviar</h3>${r.shares_preview.problemas.length ? `<div class="excepcion normal"><div class="txt">${r.shares_preview.problemas.map(esc).join('<br>')}</div></div>` : ''}<pre class="json">${esc(JSON.stringify(r.shares_preview.payload, null, 2))}</pre>` : '<p class="muted">Sin datos.</p>'}
        ${r.arca ? `<h3 style="margin-top:12px">Constatación ARCA</h3><p class="small">${esc(r.arca.resultado)} · ${esc((r.arca.observaciones || []).join(' | ') || 'sin observaciones')}</p>` : ''}
        ${d.ia?.modelo ? `<p class="small muted" style="margin-top:12px">Leído con ${esc(d.ia.modelo)}${d.ia.observaciones ? ' · ' + esc(d.ia.observaciones) : ''}</p>` : ''}
      </div></div>
      <div class="tab hidden" data-tab="hist"><div class="tabla-wrap"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Campo</th><th>Antes → Después</th></tr></thead><tbody>
        ${r.auditoria.map(a => `<tr><td class="small mono">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${esc(a.accion)}</td><td class="small mono">${esc(a.campo || '')}</td><td class="small mono">${esc(a.valor_anterior ?? '')} → ${esc(a.valor_nuevo ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="vacio">Sin movimientos.</td></tr>'}
      </tbody></table></div></div>
      </section>
      ${bots.length ? `<div class="barra-acciones">${bots.map(([bid, html, cls]) => `<button class="btn ${cls}" id="${bid}">${html}</button>`).join('')}</div>` : ''}
    </div>
  </div>`;
  conectarComprobante(el, r, editable);
}
const num0 = (v) => Number(v) || 0;
const r2v = (n) => Math.round(n * 100) / 100;

function conectarComprobante(el, r, editable) {
  const f = r.comprobante, id = f.id;
  // Visor: PDF con pdf.js o imagen
  if ((f.archivo_mime || '').startsWith('image/')) {
    api(`/api/comprobantes/${id}/archivo`, { raw: true }).then(res => res.blob()).then(b => {
      const url = URL.createObjectURL(b);
      $('#visor').innerHTML = `<div class="pdf-barra"><span class="small muted">Foto del ticket</span><span style="flex:1"></span><a class="ibtn" href="${url}" target="_blank" rel="noopener" title="Abrir en pestaña nueva">${svgI('<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>')}</a></div><div class="pdf-paginas"><img src="${url}" alt="Ticket" class="visor-img"></div>`;
    }).catch(e => { $('#visor').innerHTML = `<div class="vacio">No se pudo cargar: ${esc(e.message)}</div>`; });
  } else cargarPdf(`/api/comprobantes/${id}/archivo`);
  $$('#tabs button').forEach(b => b.onclick = () => { $$('#tabs button').forEach(x => x.classList.toggle('activo', x === b)); $$('.tab', el).forEach(t => t.classList.toggle('hidden', t.dataset.tab !== b.dataset.tab)); });
  let medio = f.medio_pago;
  $$('#seg-medio button').forEach(b => b.onclick = () => { if (!editable) return; medio = b.dataset.m; $$('#seg-medio button').forEach(x => x.classList.toggle('on', x === b)); });
  const form = $('#f-datos');
  const cta = $('[name="imputacion.codigo_concepto"]', form);
  if (cta) cta.oninput = () => { $('#den-cuenta').value = nombreCuenta(cta.value) || ''; };
  form.oninput = actualizarCuadre;
  form.onclick = (e) => { const q = e.target.closest('[data-quitar]'); if (q && editable) { q.parentElement.remove(); actualizarCuadre(); } };
  const ag = $('#add-grav'); if (ag) ag.onclick = () => { $('#gravado').insertAdjacentHTML('beforeend', filaGravado({ alicuota: 21 })); };
  const ap = $('#add-perc'); if (ap) ap.onclick = () => { $('#percepciones').insertAdjacentHTML('beforeend', filaPercepcion({ tipo: 'IIBB' })); };
  actualizarCuadre();
  const recargar = (nuevo) => { pintarComprobante(el, nuevo); S.cnt = null; contadores(); };
  const guardar = () => {
    const d = leerFormulario(r.datos);
    d.importes.exento = 0;
    d.comprobante.cotizacion = numAR(d.comprobante.cotizacion) || null;
    for (const k of ['tipo_arca', 'pto_vta', 'numero']) d.comprobante[k] = d.comprobante[k] === null || d.comprobante[k] === '' ? null : Number(String(d.comprobante[k]).replace(/\D/g, ''));
    return api('/api/comprobantes/' + id, { method: 'PUT', body: { datos: d, medio_pago: medio, nota: $('#nota').value } });
  };
  const b = (sel, fn) => { const x = $(sel); if (x) x.onclick = () => conBoton(x, fn); };
  b('#b-ok', async () => { const n = await guardar(); recargar(n); toast(n.comprobante.estado === 'lista' ? 'Guardado: quedó listo para Shares' : 'Guardado: todavía falta algo'); });
  b('#b-releer', async () => { if (!await confirmar('¿Volver a leer el archivo con la IA? Se pisan los datos cargados.')) return; recargar(await api(`/api/comprobantes/${id}/releer`, { method: 'POST' })); toast('Leído de nuevo'); });
  b('#b-reabrir', async () => recargar(await api(`/api/comprobantes/${id}/reabrir`, { method: 'POST' })));
  b('#b-enviar', async () => {
    const res = (await api('/api/shares/enviar', { method: 'POST', body: { ids: [id] } })).resultados[0];
    toast(res.ok ? `Cargado en Shares${res.shares_ref ? ' (ref. ' + res.shares_ref + ')' : ''}` : `Shares: ${res.message}`, !res.ok);
    recargar(await api('/api/comprobantes/' + id));
  });
  const brz = $('#b-rechazar');
  if (brz) brz.onclick = async () => { const motivo = await pedirTexto({ titulo: 'Rechazar comprobante', etiqueta: 'Motivo', ayuda: 'Queda registrado y se puede reabrir.', boton: 'Rechazar', minimo: 3 }); if (motivo) conBoton(brz, async () => { recargar(await api(`/api/comprobantes/${id}/rechazar`, { method: 'POST', body: { motivo } })); toast('Rechazado'); }); };
  $$('[data-aceptar]', el).forEach(bt => bt.onclick = async () => {
    const cod = bt.dataset.aceptar;
    if (cod === 'CUENTA_IA') { conBoton(bt, async () => { await guardar(); recargar(await api(`/api/comprobantes/${id}/aceptar`, { method: 'POST', body: { codigo: cod, comentario: 'Cuenta confirmada' } })); }); return; }
    const comentario = await pedirTexto({ titulo: 'Aceptar igual', ayuda: `${motivoT(cod)}: queda registrado quién lo aceptó y por qué.`, boton: 'Aceptar' });
    if (comentario) conBoton(bt, async () => recargar(await api(`/api/comprobantes/${id}/aceptar`, { method: 'POST', body: { codigo: cod, comentario } })));
  });
}

// ---------------------------------------------------------------------------
//  Enviar a Shares
// ---------------------------------------------------------------------------
async function vistaShares(el) {
  if (!puede('aprobador')) throw new Error('Necesitás rol aprobador.');
  const [r] = await Promise.all([api('/api/comprobantes?estado=lista,error_shares&limite=500'), cuentas().catch(() => [])]);
  const sel = new Set(r.comprobantes.filter(c => c.estado === 'lista').map(c => c.id));
  const existe = (v) => !(S.cuentas || []).length || (S.cuentas || []).some(c => String(c.codigo_concepto) === String(v).trim());
  el.innerHTML = `<div class="encabezado"><div><h1>Enviar a Shares</h1><p>Efectivo va al proveedor 0 "No especificado" y tarjeta al 2186 "No especificado TC", con el CUIT y el nombre del comercio. La cuenta de cada comprobante se puede modificar desde esta pantalla.</p></div>
      <div class="acciones"><span class="lote-cuenta" id="lote"><input class="in-cuenta mono" list="dl-cuentas" id="lote-cta" placeholder="Cuenta para los seleccionados"><button class="btn btn-chico" id="b-lote">Cambiar cuenta</button></span></div></div>
    ${datalistCuentas()}
    <div class="panel"><div class="tabla-wrap"><table><thead><tr><th style="width:32px"><input type="checkbox" id="chk-todo" checked></th><th>Comercio</th><th>Medio</th><th>Comprobante</th><th>Fecha</th><th>Cuenta</th><th class="num">Total</th></tr></thead><tbody>
    ${r.comprobantes.map(c => `<tr><td><input type="checkbox" data-id="${c.id}" ${sel.has(c.id) ? 'checked' : ''}></td>
      <td><a href="#/comprobante/${c.id}"><b>${esc(nombreProv(c))}</b></a>${c.estado === 'error_shares' ? ' <span class="badge b-error_shares">Error Shares</span>' : ''}</td><td>${badgeMedio(c.medio_pago)}</td>
      <td class="mono">${esc(TIPOS[c.tipo_cbte_arca] || '')} ${nroCbteC(c)}</td><td class="mono">${fmtF(c.fecha_emision)}</td><td class="td-cuenta"><input class="in-cuenta mono" list="dl-cuentas" data-cta="${c.id}" value="${esc(c.cuenta ?? '')}" placeholder="Cuenta" aria-label="Cuenta del comprobante #${c.id}"><small class="sub-celda" data-den="${c.id}">${esc(c.cuenta_denominacion || nombreCuenta(c.cuenta) || 'Sin cuenta')}</small></td><td class="num"><b>${$$m(c.total)}</b></td></tr>`).join('') || '<tr><td colspan="7" class="vacio">No hay nada listo para enviar.</td></tr>'}
    </tbody></table></div></div>
    ${r.comprobantes.length ? `<div class="barra-acciones"><div class="principal" id="tot-sel"></div><button class="btn btn-negro" id="b-env">${ICO.send}Enviar seleccionados</button></div>` : ''}<div id="res-env"></div>`;
  const pintarTot = () => { const s = r.comprobantes.filter(c => sel.has(c.id)); const t = $('#tot-sel'); if (t) t.innerHTML = `<b>${s.length}</b> seleccionado(s) · ${$$m(s.reduce((a, c) => a + (c.total || 0), 0))}`; };
  $$('[data-id]', el).forEach(ch => ch.onchange = () => { ch.checked ? sel.add(Number(ch.dataset.id)) : sel.delete(Number(ch.dataset.id)); pintarTot(); });
  const ct = $('#chk-todo'); if (ct) ct.onchange = () => { $$('[data-id]', el).forEach(ch => { ch.checked = ct.checked; ch.onchange(); }); };
  pintarTot();
  // Cambio de cuenta desde la lista (uno por uno o para los seleccionados)
  const cambiar = async (ids, cod) => {
    const res = await api('/api/comprobantes/cuenta', { method: 'POST', body: { ids, codigo_concepto: Number(cod) } });
    const mal = res.resultados.filter(x => !x.ok || x.estado !== 'lista');
    ids.forEach(id => { const i = $(`[data-cta="${id}"]`); if (i) { i.value = cod; i.dataset.ant = cod; } const sd = $(`[data-den="${id}"]`); if (sd) sd.textContent = `${res.cuenta?.denominacion || nombreCuenta(cod)} · elegida`; });
    toast(mal.length ? `Cuenta ${cod} guardada. ${mal.length} quedaron con observaciones.` : `Cuenta ${cod} guardada`, !!mal.length);
    if (mal.length) { S.cnt = null; await vistaShares(el); }
  };
  $$('[data-cta]', el).forEach(inp => {
    inp.onclick = (e) => e.stopPropagation();
    inp.onfocus = () => { inp.dataset.ant = inp.value; };
    inp.oninput = () => { const sd = $(`[data-den="${inp.dataset.cta}"]`); if (sd && inp.value && existe(inp.value)) sd.textContent = nombreCuenta(inp.value); };
    inp.onchange = async () => {
      const v = inp.value.trim();
      if (!v || v === inp.dataset.ant) return;
      if (!existe(v)) { toast(`La cuenta ${v} no está en el plan`, true); inp.value = inp.dataset.ant || ''; return; }
      inp.disabled = true;
      try { await cambiar([Number(inp.dataset.cta)], v); } catch (e) { toast(e.message, true); inp.value = inp.dataset.ant || ''; }
      inp.disabled = false;
    };
  });
  const bl = $('#b-lote');
  if (bl) bl.onclick = () => conBoton(bl, async () => {
    const v = $('#lote-cta').value.trim();
    if (!sel.size) throw new Error('Seleccioná al menos un comprobante.');
    if (!v || !existe(v)) throw new Error('Elegí una cuenta del plan.');
    await cambiar([...sel], v);
  });
  const be = $('#b-env');
  if (be) be.onclick = () => conBoton(be, async () => {
    if (!sel.size) throw new Error('Elegí al menos uno.');
    if (!await confirmar(`¿Enviar ${sel.size} comprobante(s) a Shares?`)) return;
    const res = (await api('/api/shares/enviar', { method: 'POST', body: { ids: [...sel] } })).resultados;
    const mal = res.filter(x => !x.ok);
    toast(mal.length ? `${res.length - mal.length} cargados, ${mal.length} con error` : `${res.length} cargados en Shares`, !!mal.length);
    S.cnt = null;
    await vistaShares(el);
    if (mal.length) $('#res-env').innerHTML = `<div class="panel panel-pad"><h2>Con error</h2>${mal.map(x => `<div class="linea-res mal">${ICO.x}<span><a href="#/comprobante/${x.id}">#${x.id}</a>: ${esc(x.message)}</span></div>`).join('')}</div>`;
  });
}

// ---------------------------------------------------------------------------
//  Resúmenes de la tarjeta y conciliación
// ---------------------------------------------------------------------------
const EST_MOV = { pendiente: ['Falta el comprobante', 'b-critica'], conciliado: ['Con comprobante', 'b-ok'], sin_comprobante: ['Va por asiento', 'b-warn'], no_aplica: ['No aplica', 'b-aviso'] };
const badgeMov = (e) => `<span class="badge ${(EST_MOV[e] || [])[1] || ''}">${esc((EST_MOV[e] || [e])[0])}</span>`;

async function vistaResumenes(el) {
  const r = await api('/api/resumenes');
  const s = r.comprobantes_sin_resumen || {};
  el.innerHTML = `<div class="encabezado"><div><h1>Resúmenes de la tarjeta</h1><p>Subí el PDF del resumen: la app lista cada consumo y lo cruza con los comprobantes cargados. Lo que quede sin comprobante es lo que hay que pedir (o va por asiento).</p></div>
      <div class="acciones"><button class="btn btn-acento" id="b-subir-res">${ICO.upload}Subir resumen</button></div></div>
    ${s.n ? `<a class="panel panel-pad aviso-pagos" href="#/comprobantes">${ICO.info}<span>${s.n} comprobante(s) de tarjeta (${$$m(s.monto)}) todavía no aparecen en ningún resumen: se cruzan solos cuando subas el próximo.</span>${ICO.arrow}</a>` : ''}
    <div class="panel"><div class="tabla-wrap"><table><thead><tr><th>Resumen</th><th>Cierre</th><th>Estado</th><th>Consumos</th><th>Con comprobante</th><th>Faltan</th><th class="num">Saldo</th></tr></thead><tbody>
    ${r.resumenes.map(x => `<tr class="click" data-id="${x.id}"><td><b>${esc([x.banco, x.tarjeta].filter(Boolean).join(' · ') || 'Resumen #' + x.id)}</b><small class="sub-celda">subido por ${esc(String(x.creado_por || '').split('@')[0])} · ${fmtFH(x.creado_at)}</small></td>
      <td class="mono">${fmtF(x.fecha_cierre)}</td><td>${x.estado === 'abierto' ? '<span class="badge b-acc">Abierto</span>' : x.estado === 'cerrado' ? '<span class="badge b-cargada">Cerrado</span>' : x.estado === 'leyendo' ? '<span class="badge b-recibida">Leyendo</span>' : `<span class="badge b-critica">No se pudo leer</span><small class="sub-celda">${esc(trunc(x.error_proceso || '', 80))}</small>`}</td>
      <td>${x.consumos}</td><td>${x.conciliados}</td><td>${x.pendientes ? `<b class="txt-neg">${x.pendientes}</b>` : '0'}</td><td class="num">${$$m(x.saldo_pesos)}</td></tr>`).join('') || '<tr><td colspan="7" class="vacio">Todavía no se subió ningún resumen.</td></tr>'}
    </tbody></table></div></div>`;
  $$('tr[data-id]', el).forEach(tr => tr.onclick = () => { location.hash = '#/resumen/' + tr.dataset.id; });
  $('#b-subir-res').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      let cerrar;
      modal(`<h2>Leyendo el resumen</h2><p class="muted">La IA lista todos los consumos y los cruza con los comprobantes. Puede tardar hasta un par de minutos si es largo.</p><div class="vacio"><span class="cargando"></span></div>`, { alMontar: (m, c) => { cerrar = c; } });
      try {
        const r2 = await api('/api/resumenes', { method: 'POST', body: { archivo_b64: await blobB64(f), mime: 'application/pdf', nombre: f.name } });
        cerrar(); location.hash = '#/resumen/' + r2.resumen.id;
      } catch (e) { cerrar(); toast(e.message, true); router(); }
    };
    inp.click();
  };
}
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

async function vistaResumen(el, id) {
  const r = await api('/api/resumenes/' + id);
  pintarResumen(el, r);
}
function pintarResumen(el, r) {
  const R = r.resumen, T = r.totales;
  let filtro = sessionStorage.getItem('mov_filtro') || 'pendiente';
  const abierto = R.estado === 'abierto';
  el.innerHTML = `<div class="encabezado"><div><div class="acciones" style="margin-bottom:6px"><a class="btn btn-ghost btn-chico" href="#/resumenes">${ICO.back}Resúmenes</a></div>
      <h1>${esc([R.banco, R.tarjeta].filter(Boolean).join(' · ') || 'Resumen #' + R.id)}</h1>
      <p>Cierre ${fmtF(R.fecha_cierre)}${R.fecha_vencimiento ? ` · vence ${fmtF(R.fecha_vencimiento)}` : ''} · ${R.estado === 'cerrado' ? '<span class="badge b-cargada">Cerrado</span>' : '<span class="badge b-acc">Abierto</span>'}</p></div>
      <div class="acciones"><button class="btn" id="b-ver-pdf">${ICO.doc}Ver PDF</button>${abierto ? `<button class="btn" id="b-conc">${ICO.refresh}Volver a cruzar</button>` : ''}
        ${puede('aprobador') ? (abierto ? `<button class="btn btn-negro" id="b-cerrar">Cerrar resumen</button>` : `<button class="btn" id="b-reabrir">Reabrir</button>`) : ''}<button class="btn" id="b-csv-res">${ICO.doc}CSV</button></div></div>
    ${R.estado === 'error_lectura' ? `<div class="panel panel-pad"><b class="txt-neg">No se pudo leer el resumen.</b> ${esc(R.error_proceso || '')} <button class="btn btn-chico" id="b-releer-res">Volver a leer</button></div>` : ''}
    <div class="kpis">
      <div class="kpi"><div class="et">Consumos</div><div class="val">${T.consumos}</div><div class="sub">${$$corto(T.importe_consumos)} en pesos</div></div>
      <div class="kpi ok"><div class="et">Con comprobante</div><div class="val">${T.conciliados}</div><div class="sub">${T.consumos ? Math.round(T.conciliados / T.consumos * 100) : 0}%</div></div>
      <div class="kpi ${T.pendientes ? 'alerta' : ''}"><div class="et">Falta el comprobante</div><div class="val">${T.pendientes}</div><div class="sub">${$$corto(T.importe_pendiente)} en pesos</div></div>
      <div class="kpi"><div class="et">Van por asiento</div><div class="val">${T.sin_comprobante}</div><div class="sub">intereses, sellos, sin factura</div></div>
    </div>
    <div class="seg" id="seg-mov">${[['pendiente', 'Faltan comprobantes'], ['todos', 'Todos'], ['conciliado', 'Con comprobante'], ['sin_comprobante', 'Por asiento']].map(([k, t]) => `<button data-f="${k}" class="${k === filtro ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="panel"><div class="tabla-wrap"><table><thead><tr><th>Fecha</th><th>Consumo</th><th class="num">Importe</th><th>Estado</th><th>Comprobante</th><th></th></tr></thead><tbody id="tb-mov"></tbody></table></div></div>`;
  const pintarFilas = () => {
    const ms = r.movimientos.filter(m => filtro === 'todos' || m.estado === filtro);
    $('#tb-mov').innerHTML = ms.map(m => `<tr data-mov="${m.id}">
      <td class="mono">${fmtF(m.fecha)}</td>
      <td><b>${esc(m.descripcion)}</b>${m.cuota ? `<small class="sub-celda">cuota ${esc(m.cuota)}</small>` : ''}${m.nota ? `<small class="sub-celda">${esc(m.nota)}</small>` : ''}</td>
      <td class="num"><b class="${m.importe < 0 ? 'txt-neg' : ''}">${m.moneda === 'USD' ? 'USD ' + fmtNum.format(m.importe) : $$m(m.importe)}</b></td>
      <td>${badgeMov(m.estado)}${m.conciliado_por === 'auto' ? '<small class="sub-celda">cruzado solo</small>' : ''}</td>
      <td>${m.comprobante_id ? `<a href="#/comprobante/${m.comprobante_id}">#${m.comprobante_id} ${esc(m.razon_social_emisor || '')}</a><small class="sub-celda">${fmtF(m.cbte_fecha)} · ${$$m(m.cbte_total)}</small>` : '—'}</td>
      <td><div class="acciones acc-mov">${abierto ? (m.estado === 'pendiente' ? `<button class="btn btn-chico btn-acento" data-subir="${m.id}">${ICO.camara}Cargar</button><button class="btn btn-chico" data-vincular="${m.id}">Vincular</button><button class="btn btn-chico btn-ghost" data-asiento="${m.id}">Asiento</button>`
        : (m.tipo === 'consumo' || m.estado === 'sin_comprobante' ? `<button class="btn btn-chico btn-ghost" data-pend="${m.id}">Deshacer</button>` : '')) : ''}</div></td></tr>`).join('') || `<tr><td colspan="6" class="vacio">${filtro === 'pendiente' ? '<span class="grande">Todo conciliado</span>Cada consumo tiene su comprobante o va por asiento.' : 'Nada para mostrar.'}</td></tr>`;
    const recargar = (n) => { r = n; pintarResumen(el, n); };
    $$('[data-subir]', el).forEach(b => b.onclick = async () => {
      const tipo = await elegirTipoCarga(); if (!tipo) return;
      iniciarCarga(tipo, { medio: 'tc', movimiento_id: Number(b.dataset.subir), alTerminar: async (cid) => { recargar(await api('/api/resumenes/' + R.id)); if (cid) toast(`Cargado como #${cid} y vinculado`); } });
    });
    $$('[data-vincular]', el).forEach(b => b.onclick = () => modalVincular(Number(b.dataset.vincular), async (n) => recargar(n)));
    $$('[data-asiento]', el).forEach(b => b.onclick = async () => { const nota = await pedirTexto({ titulo: 'Va por asiento', etiqueta: 'Motivo', valor: 'Sin factura: va por asiento', boton: 'Guardar', minimo: 3 }); if (nota) conBoton(b, async () => recargar(await api('/api/movimientos/' + b.dataset.asiento, { method: 'POST', body: { accion: 'sin_comprobante', nota } }))); });
    $$('[data-pend]', el).forEach(b => b.onclick = () => conBoton(b, async () => recargar(await api('/api/movimientos/' + b.dataset.pend, { method: 'POST', body: { accion: 'pendiente' } }))));
  };
  $$('#seg-mov button').forEach(b => b.onclick = () => { filtro = b.dataset.f; sessionStorage.setItem('mov_filtro', filtro); $$('#seg-mov button').forEach(x => x.classList.toggle('on', x === b)); pintarFilas(); });
  pintarFilas();
  const bb = (sel, fn) => { const x = $(sel); if (x) x.onclick = () => conBoton(x, fn); };
  bb('#b-conc', async () => { pintarResumen(el, await api(`/api/resumenes/${R.id}/conciliar`, { method: 'POST' })); toast('Cruce actualizado'); });
  bb('#b-cerrar', async () => { if (T.pendientes && !await confirmar(`Quedan ${T.pendientes} consumo(s) sin comprobante. ¿Cerrar igual?`)) return; pintarResumen(el, await api(`/api/resumenes/${R.id}/cerrar`, { method: 'POST' })); });
  bb('#b-reabrir', async () => pintarResumen(el, await api(`/api/resumenes/${R.id}/reabrir`, { method: 'POST' })));
  bb('#b-releer-res', async () => pintarResumen(el, await api(`/api/resumenes/${R.id}/releer`, { method: 'POST', body: { forzar: true } })));
  bb('#b-ver-pdf', async () => { const w = window.open('', '_blank'); const res = await api(`/api/resumenes/${R.id}/archivo`, { raw: true }); const u = URL.createObjectURL(await res.blob()); if (w) w.location = u; else location.href = u; });
  $('#b-csv-res').onclick = () => descargarCsv(`resumen_${R.id}_${R.fecha_cierre || ''}.csv`, [
    ['Fecha', 'Descripción', 'Cuota', 'Moneda', 'Importe', 'Tipo', 'Estado', 'Comprobante', 'Comercio', 'Nota'],
    ...r.movimientos.map(m => [m.fecha || '', m.descripcion, m.cuota || '', m.moneda, String(m.importe).replace('.', ','), m.tipo, (EST_MOV[m.estado] || [m.estado])[0], m.comprobante_id || '', m.razon_social_emisor || '', m.nota || '']),
  ]);
}

function elegirTipoCarga() {
  return new Promise((resolve) => {
    let listo = false;
    modal(`<h2>Cargar el comprobante de este consumo</h2><div class="medios"><button class="medio" data-t="foto">${ICO.camara}<b>Escanear ticket</b><small>Con la cámara</small></button><button class="medio" data-t="pdf">${ICO.upload}<b>Subir archivo</b><small>PDF o foto</small></button></div>`, {
      alMontar: (el, cerrar) => {
        $$('[data-t]', el).forEach(b => b.onclick = () => { listo = true; cerrar(); resolve(b.dataset.t); });
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!listo) resolve(null); } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

async function modalVincular(movId, alTerminar) {
  const r = await api(`/api/movimientos/${movId}/candidatos`);
  const m = r.movimiento;
  modal(`<h2>Vincular comprobante</h2><p class="muted">Consumo: <b>${esc(m.descripcion)}</b> · ${fmtF(m.fecha)} · ${m.moneda === 'USD' ? 'USD ' + fmtNum.format(m.importe) : $$m(m.importe)}</p>
    <input id="q-vinc" placeholder="Filtrar por comercio o importe" style="margin-bottom:10px">
    <div class="tabla-wrap tabla-scroll" style="max-height:50vh"><table><tbody id="tb-vinc">${r.candidatos.map(c => `<tr class="click" data-c="${c.id}" data-txt="${esc((nombreProv(c) + ' ' + c.total).toLowerCase())}"><td>${badgeMedio(c.medio_pago)}</td><td><b>${esc(nombreProv(c))}</b><small class="sub-celda">#${c.id} · ${badgeEstado(c.estado)}</small></td><td class="mono">${fmtF(c.fecha_emision)}</td><td class="num"><b>${$$m(c.total)}</b></td></tr>`).join('') || '<tr><td class="vacio">No hay comprobantes sin vincular.</td></tr>'}</tbody></table></div>`, {
    ancho: true,
    alMontar: (el, cerrar) => {
      $('#q-vinc', el).oninput = (e) => { const q = e.target.value.toLowerCase(); $$('#tb-vinc tr[data-c]', el).forEach(tr => tr.classList.toggle('hidden', !tr.dataset.txt.includes(q))); };
      $$('tr[data-c]', el).forEach(tr => tr.onclick = async () => {
        try { const n = await api('/api/movimientos/' + movId, { method: 'POST', body: { accion: 'vincular', comprobante_id: Number(tr.dataset.c) } }); cerrar(); toast('Vinculado'); alTerminar(n); }
        catch (e) { toast(e.message, true); }
      });
    },
  });
}

// ---------------------------------------------------------------------------
//  Configuración (admin)
// ---------------------------------------------------------------------------
async function vistaAdmin(el) {
  if (!puede('admin')) throw new Error('Necesitás rol admin.');
  el.innerHTML = `<div class="encabezado"><div><h1>Configuración</h1><p>Conexiones, usuarios, plan de cuentas, ajustes y auditoría.</p></div></div>
    <div class="panel"><div class="tabs" id="atabs">${['Salud', 'Usuarios', 'Cuentas', 'Ajustes', 'Auditoría'].map((t, i) => `<button class="${i ? '' : 'activo'}" data-t="${i}">${t}</button>`).join('')}</div><div id="acont" class="panel-pad"></div></div>`;
  const tabs = [adminSalud, adminUsuarios, adminCuentas, adminConfig, adminAuditoria];
  const ir = async (i) => {
    $$('#atabs button').forEach(b => b.classList.toggle('activo', b.dataset.t === String(i)));
    $('#acont').innerHTML = '<span class="cargando"></span>';
    try { await tabs[i]($('#acont')); } catch (e) { $('#acont').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  };
  $$('#atabs button').forEach(b => b.onclick = () => ir(Number(b.dataset.t)));
  ir(0);
}
async function adminSalud(el) {
  const s = await api('/api/salud');
  const fila = (ok, t, det, prueba) => `<tr><td>${ok ? '<span class="badge b-ok">OK</span>' : '<span class="badge b-normal">Falta</span>'}</td><td><b>${t}</b><div class="small muted">${det}</div></td><td>${prueba ? `<button class="btn btn-chico" data-probar="${prueba}">Probar</button>` : ''}</td></tr>`;
  el.innerHTML = `<table><tbody>
    ${fila(s.gemini, 'Gemini (lectura con IA)', `GEMINI_KEY · modelos ${esc(s.gemini_modelos.join(', '))}`, 'gemini')}
    ${fila(s.drive, 'Google Drive (vía Apps Script)', 'APPS_SCRIPT_URL y APPS_SCRIPT_SECRET', 'drive')}
    ${fila(s.shares, 'Shares', esc(s.shares_base), 'shares')}
    ${fila(s.arca_cert && s.arca_modo !== 'off', 'ARCA (constatación de CAE)', `modo ${esc(s.arca_modo)} · certificado ${s.arca_cert ? 'cargado' : 'falta'} (opcional)`, s.arca_modo !== 'off' ? 'arca' : '')}
    ${fila(s.cuentas > 0, 'Plan de cuentas', `${s.cuentas} cuentas`)}
    ${fila(true, 'Comercios conocidos', `${s.comercios} (la app recuerda su cuenta)`)}
  </tbody></table><p class="small muted">Versión ${esc(s.version)}</p>`;
  $$('[data-probar]', el).forEach(b => b.onclick = () => conBoton(b, async () => { const r = await api('/api/probar/' + b.dataset.probar, { method: 'POST' }); toast(r.mensaje); }));
}
async function adminCuentas(el) {
  const r = await api('/api/cuentas?todas=1');
  el.innerHTML = `<div class="acciones" style="margin-bottom:12px"><button class="btn btn-negro" id="b-sync">Sincronizar desde Shares</button><input id="qc" placeholder="Filtrar…" style="max-width:240px"></div>
    <p class="small muted">${r.cuentas.length} cuentas. Las tildadas aparecen como concepto de gasto y la IA las usa para sugerir.</p>
    <div class="tabla-wrap tabla-scroll" style="max-height:60vh"><table><thead><tr><th>Usar</th><th>Código</th><th>Denominación</th></tr></thead><tbody id="tbc">
    ${r.cuentas.map(c => `<tr data-txt="${esc((c.codigo_concepto + ' ' + c.denominacion).toLowerCase())}"><td><input type="checkbox" data-cta="${c.codigo_concepto}" ${c.usable_gasto ? 'checked' : ''}></td><td class="mono">${c.codigo_concepto}</td><td>${esc(c.denominacion)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#qc', el).oninput = (e) => { const q = e.target.value.toLowerCase(); $$('#tbc tr', el).forEach(tr => tr.classList.toggle('hidden', !tr.dataset.txt.includes(q))); };
  $$('[data-cta]', el).forEach(c => c.onchange = () => api('/api/cuentas/' + c.dataset.cta, { method: 'PUT', body: { usable_gasto: c.checked } }).then(() => { S.cuentas = null; }).catch(e => toast(e.message, true)));
  $('#b-sync', el).onclick = () => conBoton($('#b-sync', el), async () => { const x = await api('/api/cuentas/sincronizar', { method: 'POST' }); toast(`${x.cantidad} cuentas sincronizadas`); S.cuentas = null; adminCuentas(el); });
}
const DIAS_SEMANA = [];
const CFG_UI = [
  { t: 'Envío a Shares', ico: 'send', items: [
    { k: 'shares_envio_habilitado', tipo: 'switch', t: 'Enviar comprobantes a Shares', d: 'Apagado es el modo prueba: la app lee y controla todo, pero no carga nada en Shares.',
      si: 'Activado: "Enviar a Shares" carga los comprobantes de verdad', no: 'Apagado: modo prueba',
      confirmarSi: '¿Habilitar el envío real a Shares?', confirmarNo: '¿Apagar el envío a Shares?' },
    { k: 'fecha_contable', tipo: 'opciones', t: 'Fecha contable en Shares', d: 'Con qué fecha se registra el comprobante.', ops: [['emision', 'Del comprobante'], ['carga', 'De carga']] },
  ] },
  { t: 'Controles', ico: 'shield', items: [
    { k: 'tolerancia_total', tipo: 'numero', t: 'Diferencia aceptada en el total', d: 'Si neto + IVA + percepciones no da el total por más que esto, va a revisión.', pre: '$', step: 0.01 },
    { k: 'dias_antiguedad_aviso', tipo: 'numero', t: 'Aviso por comprobante viejo', d: 'Los comprobantes de hace más días que esto muestran un aviso.', suf: 'días', step: 1 },
    { k: 'arca_bloqueante', tipo: 'switch', t: 'Exigir la constatación de ARCA', d: 'Solo para facturas con CAE y si ARCA está conectado.' },
  ] },
  { t: 'Tiempo ahorrado', ico: 'clock', items: [
    { k: 'minutos_ahorrados_comprobante', tipo: 'numero', t: 'Minutos que ahorra cada comprobante', d: 'Lo que se tardaba en cargarlo a mano en Shares menos lo que lleva con la app. Se usa para el contador del Inicio.', suf: 'min', step: 0.5 },
  ] },
  { t: 'Conciliación de la tarjeta', ico: 'tarjeta', items: [
    { k: 'dias_conciliacion', tipo: 'numero', t: 'Margen de días para cruzar', d: 'Días de diferencia aceptados entre la fecha del consumo y la del comprobante.', suf: 'días', step: 1 },
  ] },
];

// ---------------------------------------------------------------------------
//  Guía
// ---------------------------------------------------------------------------
async function vistaGuia(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Guía de uso</h1><p>Cómo cargar, revisar, enviar y conciliar.</p></div></div>
    <div class="dos"><div class="panel panel-pad guia-txt">
      <h2 style="margin-bottom:10px">Cargar un comprobante</h2>
      <p><b>1. Elegí cómo se pagó.</b> Tarjeta corporativa o efectivo: define a qué proveedor va en Shares (2186 o 0).</p>
      <p><b>2. Ticket:</b> tocá "Escanear ticket", sacale la foto, ajustá las 4 esquinas y "Procesar". <b>Factura:</b> "Subir factura" y elegí el PDF (podés subir varios juntos).</p>
      <p><b>3. Se lee solo.</b> La IA saca comercio, CUIT, fecha, número, IVA y total. Si todo cierra y la cuenta es conocida, queda <b>Listo para Shares</b>; si falta algo, va a <b>Para revisar</b> con lo que hay que completar.</p>
      <p><b>4. Elegí el concepto de gasto.</b> La primera vez de cada comercio la elegís (o confirmás la que sugiere la IA); después la app la recuerda.</p>
    </div><div class="panel panel-pad guia-txt">
      <h2 style="margin-bottom:10px">Resumen de la tarjeta</h2>
      <p><b>1.</b> En "Resúmenes y conciliación" subí el PDF del resumen.</p>
      <p><b>2.</b> La app lista cada consumo y lo cruza solo con los comprobantes de tarjeta por importe y fecha.</p>
      <p><b>3.</b> En "Faltan comprobantes" quedan los que no tienen factura: cargala desde ahí mismo ("Cargar"), vinculá una ya cargada o marcala "Asiento" si no tiene factura.</p>
      <p><b>4.</b> Intereses, sellos y percepciones del banco se marcan solos como "Va por asiento". Las cuotas 2 en adelante no se cruzan (la factura va con la primera).</p>
      <p class="muted">Cuando no quede nada pendiente, cerrá el resumen.</p>
    </div></div>`;
}

// Si algo explota en el celu, que se vea en pantalla en vez de quedar en silencio
window.addEventListener('error', (e) => { if (e?.message && !/ResizeObserver/.test(e.message)) toast('Error: ' + e.message, true); });
window.addEventListener('unhandledrejection', (e) => { const m = e?.reason?.message || String(e?.reason || ''); if (m) toast('Error: ' + m, true); });

// ---------------------------------------------------------------------------
//  Ordenar cualquier tabla tocando el título de la columna (en toda la app).
//  Un toque: de mayor a menor (fechas e importes) o A→Z (texto). Otro toque: al revés.
//  Detecta solo si la columna es fecha, importe/número o texto. Se recuerda por pantalla.
// ---------------------------------------------------------------------------
const ORDEN = {
  // Una sola columna ordenada por tabla (la última que se tocó), recordada por pantalla
  clave: (th) => `orden:${location.hash.split('?')[0]}:${[...th.closest('table').querySelectorAll('thead th')].map(h => h.textContent.trim()).join('|')}`,
  valor(td) {
    if (!td) return { t: 'x', v: '' };
    if (td.dataset.orden != null) { const n = Number(td.dataset.orden); return isNaN(n) ? { t: 's', v: td.dataset.orden } : { t: 'n', v: n }; }
    // En celdas con avatar + nombre (proveedor) se usa el nombre, no las iniciales
    const base = td.querySelector('.prov b, b') || td;
    const txt = (base.innerText || base.textContent || '').trim().split('\n')[0].trim();
    let m = txt.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) { const a = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : '0000'; return { t: 'n', v: Number(a + m[2].padStart(2, '0') + m[1].padStart(2, '0')) }; }
    m = txt.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { t: 'n', v: Number(m[1] + m[2] + m[3]) };
    m = txt.replace(/\s/g, '').match(/^(-)?(?:US\$|U\$S|USD|DOL|EUR|\$)?(-)?([\d.]+(?:,\d+)?)(\s*[MK])?/i);
    if (m && /\d/.test(m[3]) && !/^\d{11}$/.test(m[3]) && !/^\d{2}-\d{8}-\d$/.test(txt)) {
      let v = Number(m[3].replace(/\./g, '').replace(',', '.'));
      if (/M/i.test(m[4] || '')) v *= 1e6; else if (/K/i.test(m[4] || '')) v *= 1e3;
      if (m[1] || m[2]) v = -v;
      if (isFinite(v)) return { t: 'n', v };
    }
    return { t: 's', v: txt.toLowerCase() };
  },
  aplicar(th, dir) {
    const tabla = th.closest('table'); const tb = tabla && tabla.tBodies[0]; if (!tb) return;
    const i = [...th.parentElement.children].indexOf(th);
    const filas = [...tb.rows].filter(r => r.cells.length > 1);
    if (filas.length < 2) return;
    const vals = filas.map(r => ({ r, k: ORDEN.valor(r.cells[i]) }));
    const num = vals.filter(x => x.k.t === 'n').length >= vals.filter(x => x.k.t === 's' && x.k.v).length;
    vals.sort((a, b) => {
      let c;
      if (num) c = (a.k.t === 'n' ? a.k.v : -Infinity) - (b.k.t === 'n' ? b.k.v : -Infinity);
      else c = String(a.k.v).localeCompare(String(b.k.v), 'es', { numeric: true });
      return dir === 'asc' ? c : -c;
    });
    vals.forEach(x => tb.appendChild(x.r));
    tabla.querySelectorAll('thead th').forEach(h => h.removeAttribute('data-dir'));
    th.dataset.dir = dir;
  },
  // Primer toque: fechas/importes de mayor a menor; texto de la A a la Z
  primero(th) {
    const tb = th.closest('table')?.tBodies[0]; if (!tb) return 'desc';
    const i = [...th.parentElement.children].indexOf(th);
    const ks = [...tb.rows].slice(0, 15).map(r => ORDEN.valor(r.cells[i]));
    return ks.filter(k => k.t === 'n').length >= ks.filter(k => k.t === 's' && k.v).length ? 'desc' : 'asc';
  },
  // No se ordenan las tablas agrupadas (filas de grupo con colspan): se desarmarían los grupos
  ordenable: (th) => th && th.closest('thead') && !th.querySelector('input,button,select') && th.textContent.trim() && th.closest('table')?.tBodies[0] && !th.closest('table').querySelector('tbody tr.grupo-prov, tbody td[colspan]:not(.vacio)') && !th.closest('table').classList.contains('sin-orden'),
};
document.addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!ORDEN.ordenable(th) || e.target.closest('input,button,select,a')) return;
  const dir = th.dataset.dir ? (th.dataset.dir === 'asc' ? 'desc' : 'asc') : ORDEN.primero(th);
  ORDEN.aplicar(th, dir);
  try { sessionStorage.setItem(ORDEN.clave(th), JSON.stringify({ i: [...th.parentElement.children].indexOf(th), dir })); } catch { }
});
// Las tablas que se dibujan de nuevo vuelven a quedar con el orden elegido
new MutationObserver(() => {
  clearTimeout(ORDEN._t);
  ORDEN._t = setTimeout(() => {
    document.querySelectorAll('table thead th').forEach(th => { if (ORDEN.ordenable(th)) th.classList.add('ordenable'); });
    document.querySelectorAll('table thead tr').forEach(tr => {
      const th0 = tr.querySelector('th.ordenable'); if (!th0) return;
      let g = null; try { g = JSON.parse(sessionStorage.getItem(ORDEN.clave(th0)) || 'null'); } catch { }
      const th = g && tr.children[g.i];
      if (th && ORDEN.ordenable(th) && th.dataset.dir !== g.dir) ORDEN.aplicar(th, g.dir);
    });
  }, 60);
}).observe(document.documentElement, { childList: true, subtree: true });
