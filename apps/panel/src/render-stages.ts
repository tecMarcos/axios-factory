import type { Queue } from '../../collector/src/notifications.js';
import { cleanText, formatRemaining, platformLabel, priorityLabels } from '../../collector/src/orders-view.js';
import type { ComponentMap } from '../../production/src/component-map.js';
import type { PackedMap } from '../../production/src/packing-store.js';
import { buildStageBoard, stageIds, stageInfo, type Piece, type StageEvent, type StageId, type StageState } from '../../production/src/stages.js';
import type { PackingCard } from '../../production/src/workflow.js';
import { deviceBox, workflowCss } from './render-workflow.js';
import { esc, shell, time } from './render.js';

const text = (value: string | null | undefined) => esc(cleanText(value));

export type StagePaths = { board: string; mark: string; undo: string; rename: string; list: string; packing: string; print: string; details: string };
export type StageOptions = {
  now: number; nonce: string; timezone: string; paths: StagePaths; device: { id: string; nome?: string };
  view?: string | null; envLabel?: string; healthBar?: string; healthCss?: string; history?: StageEvent[];
};

const css = `
.pb .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0;align-items:stretch}
.pb .tile{display:block;text-decoration:none;color:var(--ink);background:var(--card);border:2px solid var(--line);border-radius:12px;padding:6px 8px}
.pb .tile[aria-current="page"]{border-color:var(--ok);box-shadow:0 0 0 2px var(--ok) inset}
.pb .tile .n{font-size:24px;font-weight:800;line-height:1.15;white-space:nowrap}
.pb .tile .l{font-size:12px;line-height:1.2;color:var(--muted)}
.pb .tile.warn .n{color:var(--late)}
.pb .tile.done .n{color:var(--ok)}
.pb .group{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px;margin:12px 0}
.pb .ghead{display:flex;gap:10px;align-items:center}
.pb .ghead img,.pb .ghead .noimg{width:72px;height:72px;border-radius:12px;object-fit:cover;background:var(--bg);display:grid;place-items:center;font-size:30px;flex:none}
.pb .ghead .big{font-size:28px;font-weight:800}
.pb .ghead>div{flex:1}
.pb h2{margin:14px 0 2px;font-size:24px}
.pb .devfoot{margin-top:24px}
.pb .row{display:flex;gap:10px;align-items:flex-start;border-top:1px solid var(--line);padding:10px 0}
.pb .row input[type=checkbox]{width:30px;height:30px;flex:none;margin-top:2px}
.pb .row label{flex:1;display:block}
.pb .row .thumb{width:52px;height:52px;border-radius:8px;object-fit:cover;flex:none;background:var(--bg)}
.pb .undorow{padding:0 0 8px 40px;margin-top:-6px}
.pb .qty{font-size:22px;font-weight:800}
.pb .chip{display:inline-block;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:700;color:#fff;margin-right:4px}
.pb .c-OVERDUE{background:var(--late)}.pb .c-CRITICAL{background:var(--crit)}.pb .c-URGENT{background:var(--urg)}.pb .c-ATTENTION{background:var(--att);color:#1d1d1b}.pb .c-NORMAL{background:var(--ok)}.pb .c-UNKNOWN{background:var(--muted)}
.pb .names{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.pb .name{font-size:22px;font-weight:800;background:var(--note);border:1px solid var(--noteline);border-radius:10px;padding:4px 10px}
.pb .small{font-size:13px;color:var(--muted)}
.pb .undo{display:inline-block;margin-top:6px;background:none;border:1px solid var(--line);border-radius:8px;padding:4px 8px;color:var(--muted);font-size:13px}
.pb .sticky{position:sticky;bottom:8px;margin-top:12px}
.pb .sticky button{width:100%;font-size:20px;padding:16px;border-radius:14px;border:0;background:var(--ok);color:#fff;font-weight:800}
.pb .steps{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.pb .step{font-size:12px;border-radius:6px;padding:2px 6px;background:var(--bg);color:var(--muted)}
.pb .step.ok{background:var(--good);color:var(--ink)}
.pb .step.now{outline:2px solid var(--urg)}
.pb .explain{background:var(--miss);border:1px solid var(--late);border-radius:10px;padding:8px;margin:6px 0}
.pb .copy{display:block;width:100%;margin:8px 0 2px;font-size:17px;padding:10px}
`;

const deadlineChip = (c: Pick<PackingCard, 'livePriority' | 'liveHours'>) =>
  `<span class="chip c-${c.livePriority}">${priorityLabels[c.livePriority].icon} ${esc(formatRemaining(c.liveHours))}</span>`;

function photo(url: string | null) {
  return url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg" aria-hidden="true">🎄</span>';
}

function stepsBar(p: Piece) {
  return `<div class="steps">${p.etapas.map((s, i) => `<span class="step${i < p.feitas ? ' ok' : i === p.feitas ? ' now' : ''}">${i < p.feitas ? '✓ ' : ''}${esc(stageInfo[s].nome)}</span>`).join('')}<span class="step">📦 Embalar</span></div>`;
}

function pieceRow(p: Piece, withCheckbox: boolean) {
  const c = p.card;
  const id = `p-${esc(p.piece).replace(/[^a-zA-Z0-9]/g, '_')}`;
  const names = p.nomes.length ? `<div class="names">${p.nomes.map(n => `<span class="name">${text(n)}</span>`).join('')}</div>` : '';
  const undo = p.feitas > 0
    ? `<button class="undo" type="submit" formaction="__UNDO__" name="v" value="${esc(p.piece)}">↩ voltar para ${esc(stageInfo[p.etapas[p.feitas - 1]!].nome.toLowerCase())}</button>` : '';
  return `<div class="row">${withCheckbox ? `<input type="checkbox" name="p" value="${esc(p.piece)}" id="${id}">` : ''}
    ${p.foto ? `<img class="thumb" src="${esc(p.foto)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<label for="${id}"><span class="qty">${p.quantidade}×</span> ${deadlineChip(c)}
      <div class="small">${text(c.displayId)} · ${text(platformLabel(c.platform))}${c.account ? ` · ${text(c.account)}` : ''}</div>
      ${names}${stepsBar(p)}</label></div>${undo ? `<div class="undorow">${undo}</div>` : ''}`;
}

/** Uma etapa: peças agrupadas por tipo (foto + total grande), cada pedido com caixinha. */
function stageView(stage: StageId, pieces: Piece[], o: StageOptions) {
  if (!pieces.length) return `<p>Nada em <strong>${esc(stageInfo[stage].nome)}</strong> agora. 🎉</p>`;
  const groups = new Map<string, Piece[]>();
  for (const p of pieces) groups.set(p.componentId, [...(groups.get(p.componentId) ?? []), p]);
  const blocks = [...groups.values()].map(list => {
    const total = list.reduce((n, p) => n + p.quantidade, 0);
    const allNames = list.flatMap(p => p.nomes);
    const copy = stage === 'nomes' && allNames.length
      ? `<button type="button" class="btn copy" data-copy="${esc(allNames.map(n => cleanText(n)).join('\n'))}">📋 Copiar ${allNames.length} nomes</button>` : '';
    // Foto do grupo: de preferência de um pedido que só tem esta peça (ex.: Kit 4 Biscoitos, não o misto).
    const pure = list.find(p => p.foto && p.unica);
    const groupPhoto = (pure ?? list.find(p => p.foto))?.foto ?? null;
    return `<section class="group"><div class="ghead">${photo(groupPhoto)}<div><div class="big">${total} ${stage === 'nomes' ? 'nomes' : 'peças'}</div>
      <div>${text(list[0]!.nome)}</div></div></div>${copy}
      ${list.map(p => pieceRow(p, true)).join('')}</section>`;
  }).join('');
  return `<form method="post" action="${esc(o.paths.mark)}"><input type="hidden" name="e" value="${stage}">
    ${blocks.replaceAll('__UNDO__', esc(o.paths.undo))}
    <div class="sticky"><button type="submit">${stageInfo[stage].icone} ${esc(stageInfo[stage].acao)}</button></div></form>`;
}

function readyView(cards: PackingCard[], pieces: Piece[], o: StageOptions) {
  if (!cards.length) return '<p>Nenhum pedido pronto para embalar ainda.</p>';
  return `<p><a class="btn big" href="${esc(o.paths.packing)}">📦 Ir para o Embalar</a></p>
    <form method="post" action="${esc(o.paths.undo)}">${cards.map(c => {
      const own = pieces.filter(p => p.card.key === c.key);
      return `<section class="group"><div class="ghead">${photo(own[0]?.foto ?? null)}<div><div class="big">${text(c.displayId)}</div>${deadlineChip(c)}</div></div>
        ${own.map(p => pieceRow(p, false)).join('')}</section>`;
    }).join('').replaceAll('__UNDO__', esc(o.paths.undo))}</form>`;
}

function blockedView(cards: PackingCard[]) {
  if (!cards.length) return '<p>Nenhum pedido travado. 🎉</p>';
  return cards.map(c => {
    const why = c.nameValidation.status === 'sem_nomes'
      ? `O cliente <strong>não mandou os nomes</strong> (precisa de ${c.nameValidation.expected}).`
      : c.nameValidation.status === 'quantidade_divergente'
        ? `Tem <strong>${c.nameValidation.found} nome${c.nameValidation.found === 1 ? '' : 's'}</strong> na observação, mas o pedido tem <strong>${c.nameValidation.expected} mãos</strong>.`
        : c.mappingPending ? 'As peças deste anúncio ainda não foram confirmadas no mapa.' : `Revisar: ${text(c.nameValidation.reasons.join(', '))}.`;
    const todo = c.nameValidation.status === 'sem_nomes' || c.nameValidation.status === 'quantidade_divergente'
      ? 'Ver os nomes no chat do marketplace e escrever na observação do pedido no UpSeller. Ele destrava sozinho na próxima atualização.'
      : 'Avisar o Marcos.';
    return `<section class="group"><div class="ghead">${photo(c.items.find(i => i.productImg)?.productImg ?? null)}<div><div class="big">${text(c.displayId)}</div>${deadlineChip(c)}</div></div>
      <div class="explain">⛔ ${why}<div><strong>O que fazer:</strong> ${esc(todo)}</div></div>
      <div class="small">Observação atual: ${text(c.note) || '— (vazia)'}</div></section>`;
  }).join('');
}

function historyView(events: StageEvent[], tz: string) {
  if (!events.length) return '<p>Nada registrado ainda.</p>';
  return `<ul class="hist">${events.map(e => `<li${e.acao === 'voltou' ? ' class="undone"' : ''}><strong>${esc(time(Date.parse(e.em), tz))} · ${e.acao === 'feito' ? '✅' : '↩️'} ${esc(stageInfo[e.etapa].nome)}</strong>
    · ${e.quantidade}× ${text(e.peca)} · <b class="pedido">${text(e.pedido)}</b>${e.dispositivo ? ` · por ${e.dispositivo.nome ? `${text(e.dispositivo.nome)} · ` : ''}<span class="devid">${esc(e.dispositivo.id)}</span>` : ''}
    ${e.nomes?.length ? `<small>${e.nomes.map(text).join(' · ')}</small>` : ''}</li>`).join('')}</ul>`;
}

const copyScript = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;
navigator.clipboard&&navigator.clipboard.writeText(b.dataset.copy).then(()=>{b.textContent='✅ Copiado';setTimeout(()=>{b.textContent='📋 Copiar de novo'},1500)},()=>{});});`;

const views = [...stageIds, 'prontos', 'travados', 'historico'] as const;

export function renderStageBoard(queue: Queue, map: ComponentMap, state: StageState, packed: PackedMap, o: StageOptions) {
  const board = buildStageBoard(queue, map, o.now, state, packed);
  const view = views.find(v => v === o.view) ?? 'imprimir';
  const count = (s: StageId) => board.byStage[s].reduce((n, p) => n + (s === 'nomes' ? (p.nomes.length || p.quantidade) : p.quantidade), 0);
  const href = (v: string) => `${o.paths.board}${v === 'imprimir' ? '' : `?ver=${v}`}`;
  const tile = (v: typeof views[number], icon: string, n: number, label: string, cls = '') =>
    `<a class="tile ${cls}" href="${esc(href(v))}"${view === v ? ' aria-current="page"' : ''}><div class="n">${icon} ${n}</div><div class="l">${esc(label)}</div></a>`;
  const tiles = [
    tile('imprimir', stageInfo.imprimir.icone, count('imprimir'), 'imprimir'),
    tile('nomes', stageInfo.nomes.icone, count('nomes'), 'nomes 3D'),
    tile('colar', stageInfo.colar.icone, count('colar'), 'colar nomes'),
    tile('separar', stageInfo.separar.icone, count('separar'), 'separar'),
    tile('prontos', '✅', board.prontos.length, 'prontos p/ embalar', 'done'),
    tile('travados', '⛔', board.travados.length, 'travados', board.travados.length ? 'warn' : ''),
  ].join('');
  const title = view === 'imprimir' ? '🖨️ O que imprimir agora' : view === 'prontos' ? '✅ Prontos para embalar' : view === 'travados' ? '⛔ Travados' : view === 'historico' ? '🗂️ Histórico da produção'
    : `${stageInfo[view].icone} ${stageInfo[view].nome}`;
  const body = view === 'prontos' ? readyView(board.prontos, board.pieces, o)
    : view === 'travados' ? blockedView(board.travados)
      : view === 'historico' ? historyView(o.history ?? [], o.timezone)
        : stageView(view, board.byStage[view], o);
  const hint = view === 'imprimir' ? 'Marque as peças que saíram da impressora. Elas seguem sozinhas para a próxima etapa.'
    : view === 'nomes' ? 'Crie os nomes 3D de cada pedido (use “Copiar nomes”) e marque quando estiverem prontos.'
      : view === 'colar' ? 'Cole os nomes nas mãos e marque. Depois disso o pedido vai para “Prontos para embalar”.'
        : view === 'separar' ? 'Separe as peças de cada pedido e marque.' : '';
  return shell({
    title: 'Produção', nonce: o.nonce, script: copyScript,
    extraHead: `<style nonce="${esc(o.nonce)}">${workflowCss}${css}${o.healthBar && o.healthCss ? o.healthCss : ''}</style>`,
    body: `<main class="wf pb">
      <div class="titlebar"><h1>🏭 Produção</h1></div>
      <nav class="nav"><a class="btn" href="${esc(o.paths.list)}">Pedidos</a><a class="btn" href="${esc(o.paths.packing)}">📦 Embalar</a><a class="btn ghost" href="${esc(href('historico'))}">🗂️ Histórico</a><a class="btn ghost" href="${esc(o.paths.details)}">ℹ️ Detalhes</a></nav>
      ${o.healthBar ?? ''}${o.envLabel ? `<div class="banner">${text(o.envLabel)}</div>` : ''}
      <div class="tiles">${tiles}</div>
      <h2>${title}</h2>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}
      ${body}
      <div class="devfoot">${deviceBox({ device: o.device, rename: o.paths.rename })}</div>
    </main>`,
  });
}

export function renderStageDone(o: StageOptions, r: { ok: boolean; title: string; lines?: string[]; back: string }) {
  return shell({
    title: 'Produção', nonce: o.nonce, noScript: true,
    extraHead: `<style nonce="${esc(o.nonce)}">${workflowCss}${css}</style>`,
    body: `<main class="wf pb"><div class="done d-${r.ok ? 'pode_enviar' : 'nao_enviar'}">${esc(r.title)}</div>
      ${r.lines?.length ? `<ul>${r.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <p><a class="btn big" href="${esc(r.back)}">← Voltar para a Produção</a></p></main>`,
  });
}
