import type { Queue } from '../../collector/src/notifications.js';
import { calculateHoursRemaining, calculatePriority } from '../../collector/src/operational.js';
import { defaultPersonalizationKeywords, personalizationStatus, type LiveOrder } from '../../collector/src/orders-view.js';
import { normalizeCode, scanKeyFor, scannedCandidates } from '../../collector/src/scan-keys.js';
import { card, esc, shell } from './render.js';

/** Orders whose UpSeller number, marketplace number, tracking number or NF-e key matches what was scanned. */
export function findOrders(queue: Queue, scanned: string, secret: string | undefined, now: number): LiveOrder[] {
  const candidates = scannedCandidates(scanned);
  if (!candidates.length) return [];
  const keys = new Set(secret ? candidates.map(c => scanKeyFor(c, secret)) : []);
  const ids = new Set(candidates);
  return queue.orders
    .filter(o => ids.has(normalizeCode(o.orderNumber)) || (o.platformOrderId && ids.has(normalizeCode(o.platformOrderId))) || (o.scanKeys ?? []).some(k => keys.has(k)))
    .map(o => ({ ...o, livePriority: calculatePriority(o.deadlineEpoch, now), liveHours: calculateHoursRemaining(o.deadlineEpoch, now) }));
}

/** Show only the edges of a scanned code: it may be an NF-e key. */
export const maskCode = (s: string) => { const c = normalizeCode(s); return c.length <= 8 ? c : `${c.slice(0, 4)}…${c.slice(-4)}`; };

type Paths = { list: string; scan: string; lib: string };

export function renderScanPage(o: { nonce: string; paths: Paths; auto: boolean }) {
  return shell({
    title: 'Bipar', nonce: o.nonce,
    body: `
<div class="top"><div class="titlebar"><h1>Bipar etiqueta ou nota</h1><a class="btn ghost" href="${esc(o.paths.list)}">Lista</a></div>
<div class="muted">Aponte para o código de barras ou QR code da etiqueta ou da DANFE.</div></div>
<main>
  <div class="viewer"><video id="cam" muted playsinline></video><div class="aim"></div><div class="hint" id="hint">Toque em “Ligar câmera”</div></div>
  <button type="button" class="btn big" id="start">📷 Ligar câmera</button>
  <form method="post" action="${esc(o.paths.scan)}" id="f" class="manual" autocomplete="off">
    <input name="c" id="c" inputmode="text" maxlength="300" placeholder="ou digite / use um leitor USB" aria-label="Código">
    <button class="btn" type="submit">Buscar</button>
  </form>
</main>`,
    script: `
(function () {
  var NONCE = document.currentScript.nonce, LIB = ${JSON.stringify(o.paths.lib)}, AUTO = ${o.auto ? 'true' : 'false'};
  var video = document.getElementById('cam'), form = document.getElementById('f'), input = document.getElementById('c');
  var hint = document.getElementById('hint'), startBtn = document.getElementById('start'), stream = null, busy = false;
  if (!('ontouchstart' in window)) input.focus();
  function found(text) {
    if (busy || !text) return; busy = true;
    if (navigator.vibrate) navigator.vibrate(80);
    input.value = text; hint.textContent = 'Código lido! Buscando…'; stop(); form.submit();
  }
  function stop() { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  window.addEventListener('pagehide', stop);
  function native() {
    BarcodeDetector.getSupportedFormats().then(function (formats) {
      var d = new BarcodeDetector({ formats: formats });
      (function loop() {
        if (busy || !stream) return;
        d.detect(video).then(function (r) { if (r.length) found(r[0].rawValue); else setTimeout(loop, 120); }, function () { setTimeout(loop, 300); });
      })();
    }, zxing);
  }
  function zxing() {
    var s = document.createElement('script'); s.src = LIB; s.nonce = NONCE;
    s.onload = function () {
      var hints = new Map(); hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      var reader = new ZXing.BrowserMultiFormatReader(hints, 150);
      reader.decodeFromStream(stream, video, function (res) { if (res) found(res.getText()); });
    };
    s.onerror = function () { hint.textContent = 'Leitor indisponível. Digite o código abaixo.'; };
    document.head.appendChild(s);
  }
  function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hint.textContent = 'Este navegador não libera a câmera. Digite o código abaixo.'; return; }
    hint.textContent = 'Abrindo a câmera…';
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }).then(function (s) {
      stream = s; video.srcObject = s; video.play(); startBtn.style.display = 'none';
      hint.textContent = 'Aponte para o código';
      try { localStorage.setItem('axf-cam', '1'); } catch (e) {}
      if ('BarcodeDetector' in window) native(); else zxing();
    }, function () { hint.textContent = 'Sem acesso à câmera. Permita nas configurações ou digite o código.'; });
  }
  startBtn.addEventListener('click', start);
  var remembered = false; try { remembered = localStorage.getItem('axf-cam') === '1'; } catch (e) {}
  if (AUTO || remembered) start();
})();`,
  });
}

export function renderScanResult(o: { nonce: string; paths: Paths; scanned: string; matches: LiveOrder[]; timezone: string; personalizationKeywords?: string[] }) {
  const keywords = o.personalizationKeywords ?? defaultPersonalizationKeywords;
  const next = `${o.paths.scan}?auto=1`;
  const found = o.matches.length > 0;
  const missing = o.matches.some(m => personalizationStatus(m, keywords) === 'MISSING');
  const banner = found
    ? `<div class="banner ${missing ? 'bad' : 'ok'}">${missing ? '⚠️ Pedido encontrado — falta o nome no UpSeller' : '✅ Pedido encontrado'}</div>`
    : `<div class="banner bad">❌ Não encontrei esse código</div>
       <p>Código lido: <strong>${esc(maskCode(o.scanned))}</strong></p>
       <p class="muted">Pode ser um pedido que já foi enviado, ou que entrou depois da última atualização da lista (ela atualiza a cada 30 min).</p>`;
  return shell({
    title: found ? 'Pedido' : 'Não encontrado', nonce: o.nonce,
    body: `
<div class="top"><div class="titlebar"><h1>Conferência</h1><a class="btn ghost" href="${esc(o.paths.list)}">Lista</a></div></div>
<main>
  ${banner}
  ${o.matches.map(m => card(m, { timezone: o.timezone, personalizationKeywords: keywords, large: true })).join('')}
  <a class="btn big" href="${esc(next)}">📷 Bipar ${found ? 'o próximo' : 'de novo'}</a>
</main>`,
  });
}
