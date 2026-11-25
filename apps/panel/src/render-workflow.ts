import type { Queue } from '../../collector/src/notifications.js';
import { cleanText, formatRemaining, platformLabel, priorityLabels, stageLabel } from '../../collector/src/orders-view.js';
import type { ComponentMap } from '../../production/src/component-map.js';
import type { LiveOrder } from '../../collector/src/orders-view.js';
import { PACK_TIME, type HistoryEvent, type PackedMap, type PackTime } from '../../production/src/packing-store.js';
import { buildPackingQueue, buildPrintQueue, itemLabel, packingChecklist, type Decision, type PackingCard, type PrintJob } from '../../production/src/workflow.js';
import { card, esc, shell, time } from './render.js';

const text = (value: string | null | undefined) => esc(cleanText(value));
type Links = { list: string; production: string; print: string; packing: string; scan?: string };
/** Bancada com leitor: rotas de POST e o leitor de código já montado. */
export type PackingStation = { confirm: string; undo: string; rename: string; device: { id: string; nome?: string }; scanner: { html: string; script: string };
  /** Carimbo do cronômetro oculto para o pedido aberto (vai num campo escondido do formulário). */
  timer?: (key: string) => string };
type Options = { history?: HistoryEvent[]; historyQuery?: string; all?: boolean; view?: string | null; now: number; nonce: string; links: Links; envLabel?: string; healthBar?: string; healthCss?: string; refreshSeconds?: number; timezone?: string; packed?: PackedMap; station?: PackingStation };

export const workflowCss = `
.ptime{display:inline-block;font-size:13px;border-radius:6px;padding:1px 6px;margin-left:4px}
.t-normal{background:var(--bg);color:var(--muted)}
.t-rapido{background:var(--late);color:#fff;font-weight:700}
.t-fora{background:var(--bg);color:var(--muted);font-style:italic}
.tsum{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:10px 0}
.tsum h2{margin:0 0 4px;font-size:18px}
.tt{width:100%;border-collapse:collapse;font-size:14px;overflow-wrap:normal}.tt th,.tt td+td{white-space:nowrap}.tt th,.tt td{text-align:left;padding:4px;border-top:1px solid var(--line)}
.wf{overflow-wrap:anywhere}
.wf h2{font-size:18px;margin:22px 0 8px}
.wf .nav{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.wf .banner{font-weight:bold;background:var(--note);border:1px solid var(--noteline);border-radius:10px;padding:8px}
.wf .decision{font-weight:bold;border-radius:10px;padding:8px;margin:6px 0}
.wf .d-pode_enviar{background:var(--good);border:1px solid var(--ok)}
.wf .d-revisar{background:var(--note);border:1px solid var(--urg)}
.wf .d-nao_enviar{background:var(--miss);border:1px solid var(--late)}
.wf .d-ja_embalado{background:var(--card);border:1px solid var(--line)}
.wf .next{border:3px solid var(--ok)}
.wf table{width:100%;border-collapse:collapse;background:var(--card);text-align:left}
.wf th,.wf td{padding:6px;border-bottom:1px solid var(--line);vertical-align:top}
.wf .check{display:flex;gap:8px;align-items:flex-start;padding:4px 0;font-size:18px}
.wf .check input{width:22px;height:22px;flex:none}
.wf .q{display:flex;gap:12px;align-items:center;justify-content:space-between;background:var(--card);border:2px solid var(--line);border-radius:12px;padding:12px;margin:8px 0;font-size:19px;font-weight:600}
.wf .q input{width:30px;height:30px;flex:none}
.wf .q:has(input:checked){border-color:var(--ok);background:var(--good)}
.wf .sim{font-size:15px;white-space:nowrap}
.wf .names{font-size:22px;font-weight:700;margin:4px 0 0}
.wf .done{font-size:22px;font-weight:bold;border-radius:12px;padding:14px;margin:8px 0}
.wf form.inline{display:inline}
.wf .tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:14px 0 4px}
.wf .tabs a{text-align:center;overflow-wrap:normal;word-break:normal}
.wf .pedido{font-family:ui-monospace,monospace}
.wf .tabs a[aria-current="page"]{outline:3px solid var(--ok);outline-offset:1px}
.wf .photos{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.wf .photos img,.wf .photos .noimg{width:88px;height:88px;border-radius:10px;object-fit:cover;background:var(--bg);display:grid;place-items:center;font-size:30px}
.wf .big-photos img,.wf .big-photos .noimg{width:140px;height:140px}
.wf .pick{margin-top:10px}
.wf .tag-next{display:inline-block;background:var(--ok);color:#fff;border-radius:6px;padding:2px 8px;font-size:13px;font-weight:bold}
.wf .device{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;margin:8px 0}
.wf .device input{flex:1;min-width:140px;font-size:16px;padding:8px;border:1px solid var(--line);border-radius:8px}
.wf .devid{font-family:ui-monospace,monospace;font-weight:bold;letter-spacing:1px}
.wf .who{font-size:14px}
.wf .hist{list-style:none;padding:0;margin:0}
.wf .hist li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;margin:6px 0}
.wf .hist .undone{opacity:.75;border-style:dashed}
.wf .hist small{display:block;color:var(--muted)}
.wf form.search{display:flex;gap:6px;margin:8px 0}
.wf form.search input{flex:1;font-size:16px;padding:8px;border:1px solid var(--line);border-radius:8px}
.wf details.scanner summary{cursor:pointer;font-weight:bold;font-size:18px;margin:10px 0}
`;

export const decisionCss = '.wf .decision{font-weight:bold;border-radius:10px;padding:8px;margin:6px 0}.wf .d-pode_enviar{background:var(--good);border:1px solid var(--ok)}.wf .d-revisar{background:var(--note);border:1px solid var(--urg)}.wf .d-nao_enviar{background:var(--miss);border:1px solid var(--late)}.wf .d-ja_embalado{background:var(--card);border:1px solid var(--line)}';

export const decisionLabels = { pode_enviar: '✅ PODE ENVIAR', revisar: '🟡 REVISAR ANTES', nao_enviar: '⛔ NÃO ENVIAR', ja_embalado: '📦 JÁ EMBALADO' } as const;

export function decisionBlock(d: Decision) {
  return `<div class="decision d-${d.status}">${decisionLabels[d.status]} · ${text(d.motivo)}<div class="muted">${text(d.acao)}</div></div>`;
}

function nav(l: Links) {
  return `<nav class="nav"><a class="btn" href="${esc(l.list)}">Pedidos</a><a class="btn" href="${esc(l.production)}">🧩 Produção</a><a class="btn" href="${esc(l.print)}">🖨️ Impressão</a><a class="btn" href="${esc(l.packing)}">📦 Embalar</a>${l.scan ? `<a class="btn" href="${esc(l.scan)}">📷 Bipar</a>` : ''}</nav>`;
}

function page(title: string, o: Options, body: string, refresh: boolean, script?: string) {
  return shell({
    title, nonce: o.nonce, noScript: script === undefined, script, refreshSeconds: refresh ? o.refreshSeconds : undefined,
    extraHead: `<style nonce="${esc(o.nonce)}">${workflowCss}${o.healthBar && o.healthCss ? o.healthCss : ''}</style>`,
    body: `<main class="wf">
      <div class="titlebar"><h1>${esc(title)}</h1></div>
      ${nav(o.links)}
      ${o.healthBar ?? ''}${o.envLabel ? `<div class="banner">${text(o.envLabel)}</div>` : ''}
      ${body}
    </main>`,
  });
}

const when = (job: Pick<PrintJob, 'livePriority' | 'liveHours'>) => `${priorityLabels[job.livePriority].icon} ${esc(formatRemaining(job.liveHours))}`;

export function renderPrintQueue(queue: Queue, map: ComponentMap, o: Options) {
  const { lines, unmapped } = buildPrintQueue(queue, map, o.now, o.packed);
  const summary = lines.map(l => `<tr><th scope="row">${text(l.nome)}</th><td><strong>${l.agora}</strong></td><td>${l.aguardando}</td></tr>`).join('');
  const sections = lines.filter(l => l.jobs.length || l.bloqueados.length).map(l => {
    const jobs = l.jobs.map(j => `<tr><td>${when(j)}</td><td>${text(j.displayId)}</td><td><strong>${j.count}×</strong></td>${l.personalizado ? `<td>${j.names.length ? j.names.map(text).join(', ') : '<span class="muted">ver pedido</span>'}</td>` : ''}</tr>`).join('');
    const blocked = l.bloqueados.map(j => `<li>${text(j.displayId)} · ${j.count}× · ${text(j.motivo)}</li>`).join('');
    return `<section><h2>${text(l.nome)} · imprimir ${l.agora}</h2>
      ${jobs ? `<table><thead><tr><th scope="col">Prazo</th><th scope="col">Pedido</th><th scope="col">Qtd</th>${l.personalizado ? '<th scope="col">Nomes</th>' : ''}</tr></thead><tbody>${jobs}</tbody></table>` : '<p>Nada liberado para imprimir.</p>'}
      ${blocked ? `<details><summary>${l.aguardando} esperando liberação (não imprimir ainda)</summary><ul>${blocked}</ul></details>` : ''}
    </section>`;
  }).join('');
  return page('Fila de impressão', o, `
    <p class="muted">Ordem: prazo mais curto primeiro. Só entram pedidos liberados (nomes e peças conferidos). Cordões não aparecem aqui porque não são impressos.</p>
    <table><thead><tr><th scope="col">Peça</th><th scope="col">Imprimir agora</th><th scope="col">Esperando liberação</th></tr></thead><tbody>${summary}</tbody></table>
    ${sections || '<p>Nenhuma peça na fila.</p>'}
    ${unmapped.length ? `<p class="decision d-revisar">${unmapped.length} variante(s) natalina(s) sem mapa: as peças delas não estão contadas. Veja em Produção.</p>` : ''}`, true);
}

function packingCard(c: PackingCard, map: ComponentMap, next: boolean, station = false) {
  const name = (id: string) => text(Object.hasOwn(map.componentes, id) ? map.componentes[id]!.nome : id);
  const checks = station
    ? `<ul>${Object.entries(c.parts).filter(([, n]) => n > 0).map(([id, n]) => `<li>${n}× ${name(id)}</li>`).join('')}${c.items.filter(i => i.resolution.kind === 'other').map(i => `<li>${i.quantity}× ${text(i.productAttr || i.productName)}</li>`).join('')}</ul>`
    : Object.entries(c.parts).filter(([, n]) => n > 0)
      .map(([id, n]) => `<label class="check"><input type="checkbox"> ${n}× ${name(id)}</label>`).join('');
  const names = c.nameValidation.names.length ? `<div class="note"><strong>Nomes:</strong> ${c.nameValidation.names.map(text).join(', ')}</div>` : '';
  const others = station ? '' : c.items.filter(i => i.resolution.kind === 'other').map(i => `<label class="check"><input type="checkbox"> ${i.quantity}× ${text(i.productAttr || i.productName)}</label>`).join('');
  const platformClass = c.platform === 'shopee' || c.platform === 'tiktok' ? c.platform : 'other';
  return `<article class="card p-${c.livePriority}${next ? ' next' : ''}">
    <header><span class="badge ${platformClass}">${text(platformLabel(c.platform))}</span>
      ${c.account ? `<span class="acct">${text(c.account)}</span>` : ''}
      <span class="due">${esc(formatRemaining(c.liveHours))}</span></header>
    <div class="id">${text(c.displayId)}</div>
    <div class="muted">${esc(stageLabel(c.stage, c.printLabelState))}</div>
    ${decisionBlock(c.decision)}
    ${c.decision.status === 'pode_enviar' ? `${checks}${others}${names}` : `<div class="muted">Nota: ${text(c.note) || '—'}</div>`}
  </article>`;
}

export function renderPacking(queue: Queue, map: ComponentMap, o: Options) {
  const { proximo, fila, travados, embalados, embaladosAqui } = buildPackingQueue(queue, map, o.now, o.packed);
  const st = o.station;
  const queueHtml = `
    <section><h2>Próximo a embalar</h2>${proximo ? packingCard(proximo, map, true, !!st) : '<p>Nenhum pedido liberado para embalar.</p>'}</section>
    <section><h2>Depois (${fila.length})</h2>${fila.map(c => packingCard(c, map, false, !!st)).join('') || '<p>Fila vazia.</p>'}</section>
    <section><h2>Não enviar ainda (${travados.length})</h2>${travados.map(c => packingCard(c, map, false, !!st)).join('') || '<p>Nenhum pedido travado.</p>'}</section>`;
  if (!st) {
    return page('Bancada de embalagem', o, `
    <p class="muted">O primeiro é o liberado com prazo mais curto. Marque cada peça ao colocar na embalagem e bipe a etiqueta no fim para conferir. Esta página não atualiza sozinha, para não apagar as marcações.</p>
    ${queueHtml}
    <p class="muted">${embalados} pedido(s) já embalado(s), aguardando coleta.</p>`, false);
  }
  return renderStation(queue, map, o, st);
}

/** Fotos dos itens do pedido (só URLs https já filtradas pelo coletor). */
function photos(c: Pick<PackingCard, 'items'>, big = false) {
  const seen = new Set<string>();
  const imgs = c.items.map(i => i.productImg).filter((u): u is string => !!u && !seen.has(u) && !!seen.add(u))
    .map(u => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('');
  return `<div class="photos${big ? ' big-photos' : ''}">${imgs || '<span class="noimg" aria-hidden="true">📦</span>'}</div>`;
}

function contents(c: PackingCard, map: ComponentMap) {
  const name = (id: string) => text(Object.hasOwn(map.componentes, id) ? map.componentes[id]!.nome : id);
  const parts = Object.entries(c.parts).filter(([, n]) => n > 0).map(([id, n]) => `<li>${n}× ${name(id)}</li>`).join('');
  const others = c.items.filter(i => i.resolution.kind === 'other').map(i => `<li>${i.quantity}× ${esc(itemLabel(i))}</li>`).join('');
  const names = c.nameValidation.names.length ? `<div class="note"><strong>Nomes:</strong> ${c.nameValidation.names.map(text).join(', ')}</div>` : '';
  return `<ul>${parts}${others}</ul>${names}`;
}

/** 45s · 1min 05s · 2h 10min */
export function formatDuration(segundos: number) {
  const s = Math.round(segundos);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}min`;
}

/** Tempo que o pedido levou para ser embalado, com alerta quando foi rápido demais. */
export function packTimeTag(t: PackTime | undefined) {
  if (!t) return '';
  if (t.status === 'rapido') return ` <span class="ptime t-rapido">⚠️ ${esc(formatDuration(t.segundos))} · rápido demais: não seguiu o processo?</span>`;
  if (t.status === 'fora') return ` <span class="ptime t-fora">⏱️ ${esc(formatDuration(t.segundos))} · fora da média (bipou e saiu?)</span>`;
  return ` <span class="ptime t-normal">⏱️ ${esc(formatDuration(t.segundos))}</span>`;
}

/** Resumo do tempo por pedido: média só dos tempos normais; rápidos e descartados contados à parte. */
function timeSummary(events: { acao: string; tempo?: PackTime; dispositivo?: { id: string; nome?: string } }[]) {
  const timed = events.filter(e => e.acao === 'embalado' && e.tempo);
  if (!timed.length) return '';
  const stats = (list: typeof timed) => {
    const ok = list.filter(e => e.tempo!.status === 'normal').map(e => e.tempo!.segundos).sort((a, b) => a - b);
    return { n: ok.length, media: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0, mediana: ok.length ? ok[Math.floor(ok.length / 2)]! : 0,
      rapidos: list.filter(e => e.tempo!.status === 'rapido').length, fora: list.filter(e => e.tempo!.status === 'fora').length };
  };
  const all = stats(timed);
  const people = new Map<string, { label: string; list: typeof timed }>();
  for (const e of timed) {
    const id = e.dispositivo?.id ?? '—';
    const entry = people.get(id) ?? { label: e.dispositivo ? `${e.dispositivo.nome ? `${e.dispositivo.nome} · ` : ''}${e.dispositivo.id}` : 'sem aparelho', list: [] };
    entry.list.push(e);
    people.set(id, entry);
  }
  const row = (label: string, s: ReturnType<typeof stats>) => `<tr><td>${text(label)}</td><td>${s.n ? esc(formatDuration(s.media)) : '—'}</td><td>${s.n}</td><td>${s.rapidos ? `⚠️ ${s.rapidos}` : '0'}</td><td>${s.fora}</td></tr>`;
  return `<section class="tsum"><h2>⏱️ Tempo por pedido</h2>
    <p><strong>Média ${all.n ? esc(formatDuration(all.media)) : '—'}</strong>${all.n ? ` · mediana ${esc(formatDuration(all.mediana))}` : ''} · ${all.n} pedido${all.n === 1 ? '' : 's'} contados${all.rapidos ? ` · <span class="t-rapido">⚠️ ${all.rapidos} rápido${all.rapidos === 1 ? '' : 's'} demais</span>` : ''}${all.fora ? ` · ${all.fora} descartado${all.fora === 1 ? '' : 's'}` : ''}</p>
    <p class="muted">Conta da abertura do pedido (bipar ou escolher) até salvar. Menos de ${PACK_TIME.rapidoSeg}s acende alerta; mais de ${PACK_TIME.foraSeg / 60} min fica fora da média.</p>
    ${people.size > 1 || timed.some(e => e.dispositivo) ? `<table class="tt"><thead><tr><th>Quem</th><th>Média</th><th>Pedidos</th><th>⚠️</th><th>Fora</th></tr></thead><tbody>${[...people.values()].map(p => row(p.label, stats(p.list))).join('')}</tbody></table>` : ''}
  </section>`;
}

/** "por Nome · ID" de quem marcou o pedido como embalado. */
export function packedBy(d: Decision) {
  if (!d.dispositivo) return '';
  return ` <span class="who">por ${d.dispositivo.nome ? `${text(d.dispositivo.nome)} · ` : ''}<span class="devid">${esc(d.dispositivo.id)}</span></span>`;
}

export function deviceBox(st: Pick<PackingStation, 'device' | 'rename'>) {
  return `<form class="device" method="post" action="${esc(st.rename)}" autocomplete="off">
    <span>📱 Este aparelho: <span class="devid">${esc(st.device.id)}</span></span>
    <input name="n" maxlength="30" value="${esc(st.device.nome ?? '')}" placeholder="Seu nome (ex.: Marcos)" aria-label="Nome de quem usa este aparelho">
    <button type="submit">Salvar</button></form>`;
}

function stationCard(c: PackingCard, map: ComponentMap, o: Options, st: PackingStation, mode: 'fila' | 'travado' | 'embalado', next = false) {
  const tz = o.timezone ?? 'America/Sao_Paulo';
  const platformClass = c.platform === 'shopee' || c.platform === 'tiktok' ? c.platform : 'other';
  const action = mode === 'fila'
    ? `<form class="pick" method="post" action="${esc(o.links.packing)}"><input type="hidden" name="k" value="${esc(c.key)}"><button class="btn big" type="submit">📦 Embalar este</button></form>`
    : mode === 'embalado' && c.decision.embaladoEm
      ? `<div><strong>Embalado às ${esc(time(Date.parse(c.decision.embaladoEm), tz))}</strong>${packedBy(c.decision)}${packTimeTag(c.decision.tempo)}
          <form class="inline" method="post" action="${esc(st.undo)}"><input type="hidden" name="k" value="${esc(c.key)}"><button type="submit">Desfazer</button></form></div>`
      : mode === 'embalado' ? '<div><strong>Aguardando coleta (UpSeller)</strong></div>' : decisionBlock(c.decision);
  return `<article class="card p-${c.livePriority}${next ? ' next' : ''}">
    <header>${next ? '<span class="tag-next">PRÓXIMO</span>' : ''}<span class="badge ${platformClass}">${text(platformLabel(c.platform))}</span>
      ${c.account ? `<span class="acct">${text(c.account)}</span>` : ''}
      <span class="due">${esc(formatRemaining(c.liveHours))}</span></header>
    <div class="id">${text(c.displayId)}</div>
    ${photos(c)}
    ${contents(c, map)}
    ${mode === 'travado' ? `<div class="muted">Nota: ${text(c.note) || '—'}</div>` : ''}
    ${action}
  </article>`;
}

/** Histórico permanente de embalagens, de qualquer aparelho, agrupado por dia. */
function historyView(o: Options, st: PackingStation) {
  const tz = o.timezone ?? 'America/Sao_Paulo';
  const q = cleanText(o.historyQuery).toUpperCase();
  const events = (o.history ?? []).filter(e => !q || e.pedido.toUpperCase().includes(q) || (e.dispositivo?.nome ?? '').toUpperCase().includes(q) || (e.dispositivo?.id ?? '').includes(q));
  const day = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
  let current = '';
  const rows = events.slice(0, 500).map(e => {
    const d = day(e.em);
    const header = d !== current ? `</ul><h2>${esc(d)}</h2><ul class="hist">` : '';
    current = d;
    const by = e.dispositivo ? ` · por ${e.dispositivo.nome ? `${text(e.dispositivo.nome)} · ` : ''}<span class="devid">${esc(e.dispositivo.id)}</span>` : '';
    return `${header}<li${e.acao === 'desfeito' ? ' class="undone"' : ''}><strong>${esc(time(Date.parse(e.em), tz))} · ${e.acao === 'embalado' ? '✅ Embalado' : '↩️ Desfeito'}</strong> · <b class="pedido">${text(e.pedido)}</b>${by}${e.acao === 'embalado' ? packTimeTag(e.tempo) : ''}
      ${e.itens.length ? `<small>${e.itens.map(text).join(' · ')}</small>` : ''}</li>`;
  }).join('');
  return `<form class="search" method="get" action="${esc(o.links.packing)}"><input type="hidden" name="ver" value="historico">
      <input name="q" value="${esc(o.historyQuery ?? '')}" maxlength="60" placeholder="Buscar pedido, nome ou ID do aparelho" aria-label="Buscar no histórico"><button type="submit">Buscar</button></form>
    ${timeSummary(events)}
    <p class="muted">Tudo o que foi embalado ou desfeito, por qualquer aparelho. Nada é apagado daqui.</p>
    ${rows ? `<ul class="hist">${rows}</ul>` : '<p>Nada no histórico ainda.</p>'}${events.length > 500 ? '<p class="muted">Mostrando os 500 mais recentes. Use a busca.</p>' : ''}`;
}

const stationViews = ['fila', 'travados', 'embalados', 'historico'] as const;

/** Bancada: leitor no topo e três abas — falta embalar, não enviar, embalados. */
function renderStation(queue: Queue, map: ComponentMap, o: Options, st: PackingStation) {
  const { proximo, fila, travados, embaladosAqui, aguardandoColeta } = buildPackingQueue(queue, map, o.now, o.packed, { all: o.all });
  const pending = proximo ? [proximo, ...fila] : [];
  const view = stationViews.find(v => v === o.view) ?? 'fila';
  const tab = (v: typeof stationViews[number], label: string, n: number) =>
    `<a class="btn${view === v ? '' : ' ghost'}" href="${esc(o.links.packing)}${v === 'fila' ? '' : `?ver=${v}`}"${view === v ? ' aria-current="page"' : ''}>${label} (${n})</a>`;
  const body = view === 'historico' ? historyView(o, st)
    : view === 'fila'
    ? (pending.map((c, i) => stationCard(c, map, o, st, 'fila', i === 0)).join('') || '<p>Nada para embalar agora. 🎉</p>')
    : view === 'travados'
      ? (travados.map(c => stationCard(c, map, o, st, 'travado')).join('') || '<p>Nenhum pedido travado.</p>')
      : `<h2>Embalados na bancada (${embaladosAqui.length})</h2>${embaladosAqui.map(c => stationCard(c, map, o, st, 'embalado')).join('') || '<p>Nenhum ainda.</p>'}
         <h2>Aguardando coleta no UpSeller (${aguardandoColeta.length})</h2>${aguardandoColeta.map(c => stationCard(c, map, o, st, 'embalado')).join('') || '<p>Nenhum.</p>'}`;
  return page('Embalar', o, `
    ${deviceBox(st)}
    <details class="scanner"${view === 'fila' ? ' open' : ''}><summary>📷 Bipar etiqueta</summary>
    ${st.scanner.html}</details>
    <p class="muted">Bipe a etiqueta ou escolha um pedido na lista. Depois responda "Sim" em todas as perguntas.</p>
    <nav class="tabs">${tab('fila', 'Falta embalar', pending.length)}${tab('travados', 'Não enviar', travados.length)}${tab('embalados', 'Embalados', embaladosAqui.length + aguardandoColeta.length)}<a class="btn${view === 'historico' ? '' : ' ghost'}" href="${esc(o.links.packing)}?ver=historico"${view === 'historico' ? ' aria-current="page"' : ''}>🗂️ Histórico</a></nav>
    ${body}`, false, st.scanner.script);
}

type ScanResult = { fromList?: boolean; scanned: string; matches: LiveOrder[]; cards: Map<string, PackingCard>; keyOf: (o: LiveOrder) => string; nextHref: string; personalizationKeywords: string[] };

/** Tela depois de bipar: as perguntas de "Sim" do pedido, ou o motivo de não embalar. */
export function renderPackingScan(map: ComponentMap, r: ScanResult, o: Options & { station: PackingStation }) {
  const tz = o.timezone ?? 'America/Sao_Paulo';
  const blocks = r.matches.map(m => {
    const c = r.cards.get(r.keyOf(m));
    if (!c) {
      return `<div class="decision d-revisar">Este produto ainda não tem roteiro de embalagem no painel. Embale conferindo o pedido abaixo.</div>
        ${card(m, { timezone: tz, personalizationKeywords: r.personalizationKeywords, large: true })}`;
    }
    const head = `<div class="id">${text(c.displayId)}</div><div class="muted">${text(platformLabel(c.platform))}${c.account ? ` · ${text(c.account)}` : ''} · ${esc(formatRemaining(c.liveHours))}</div>${photos(c, true)}`;
    if (c.decision.status === 'ja_embalado') {
      const at = c.decision.embaladoEm ? ` às ${esc(time(Date.parse(c.decision.embaladoEm), tz))}` : '';
      const undo = c.decision.embaladoEm ? `<form method="post" action="${esc(o.station.undo)}"><input type="hidden" name="k" value="${esc(c.key)}"><button type="submit">Desfazer embalagem</button></form>` : '';
      return `${head}<div class="done d-ja_embalado">📦 Já embalado${at}${packedBy(c.decision)}</div>${undo}`;
    }
    if (c.decision.status !== 'pode_enviar') {
      return `${head}${decisionBlock(c.decision)}<p><strong>Não embale.</strong> Separe o pedido e avise o Marcos.</p><div class="muted">Nota: ${text(c.note) || '—'}</div>`;
    }
    const checks = packingChecklist(c, map, r.fromList).map(q => `<label class="q"><span>${text(q.pergunta)}${q.detalhe?.length ? `<div class="names">${q.detalhe.map(text).join(' · ')}</div>` : ''}</span>
        <span class="sim"><input type="checkbox" name="q" value="${esc(q.id)}" required> Sim</span></label>`).join('');
    return `${head}${decisionBlock(c.decision)}
      <form method="post" action="${esc(o.station.confirm)}" autocomplete="off">
        <input type="hidden" name="k" value="${esc(c.key)}">${o.station.timer ? `<input type="hidden" name="t0" value="${esc(o.station.timer(c.key))}">` : ''}${r.fromList ? '\n        <input type="hidden" name="origem" value="lista">' : ''}
        ${checks}
        <button class="btn big" type="submit">✅ Pedido embalado</button>
      </form>`;
  }).join('<hr>');
  const notFound = `<div class="done d-nao_enviar">❌ Não encontrei esse código</div>
    <p class="muted">Pode ser um pedido já enviado ou que entrou depois da última atualização da lista.</p>`;
  return page('Embalar', o, `${blocks || notFound}<p><a class="btn big ghost" href="${esc(o.links.packing)}">← Voltar para a lista</a></p><p><a class="btn big" href="${esc(r.nextHref)}">📷 Bipar ${blocks ? 'outro' : 'de novo'}</a></p>`, false);
}

/** Resposta depois de "Pedido embalado" ou "Desfazer". */
export function renderPackingDone(o: Options, r: { ok: boolean; title: string; detail?: string; nextHref: string }) {
  return page('Embalar', o, `<div class="done d-${r.ok ? 'pode_enviar' : 'nao_enviar'}">${esc(r.title)}</div>
    ${r.detail ? `<p>${esc(r.detail)}</p>` : ''}
    <p><a class="btn big" href="${esc(o.links.packing)}">📋 Voltar para a lista</a></p>
    <p><a class="btn big ghost" href="${esc(r.nextHref)}">📷 Bipar o próximo</a></p>`, false);
}
