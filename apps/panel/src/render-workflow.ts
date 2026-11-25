import type { Queue } from '../../collector/src/notifications.js';
import { cleanText, formatRemaining, platformLabel, priorityLabels, stageLabel } from '../../collector/src/orders-view.js';
import type { ComponentMap } from '../../production/src/component-map.js';
import { buildPackingQueue, buildPrintQueue, type Decision, type PackingCard, type PrintJob } from '../../production/src/workflow.js';
import { esc, shell } from './render.js';

const text = (value: string | null | undefined) => esc(cleanText(value));
type Links = { list: string; production: string; print: string; packing: string; scan: string };
type Options = { now: number; nonce: string; links: Links; envLabel?: string; healthBar?: string; healthCss?: string; refreshSeconds?: number };

const css = `
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
`;

export const decisionCss = '.wf .decision{font-weight:bold;border-radius:10px;padding:8px;margin:6px 0}.wf .d-pode_enviar{background:var(--good);border:1px solid var(--ok)}.wf .d-revisar{background:var(--note);border:1px solid var(--urg)}.wf .d-nao_enviar{background:var(--miss);border:1px solid var(--late)}.wf .d-ja_embalado{background:var(--card);border:1px solid var(--line)}';

export const decisionLabels = { pode_enviar: '✅ PODE ENVIAR', revisar: '🟡 REVISAR ANTES', nao_enviar: '⛔ NÃO ENVIAR', ja_embalado: '📦 JÁ EMBALADO' } as const;

export function decisionBlock(d: Decision) {
  return `<div class="decision d-${d.status}">${decisionLabels[d.status]} · ${text(d.motivo)}<div class="muted">${text(d.acao)}</div></div>`;
}

function nav(l: Links) {
  return `<nav class="nav"><a class="btn" href="${esc(l.list)}">Pedidos</a><a class="btn" href="${esc(l.production)}">🧩 Produção</a><a class="btn" href="${esc(l.print)}">🖨️ Impressão</a><a class="btn" href="${esc(l.packing)}">📦 Embalar</a><a class="btn" href="${esc(l.scan)}">📷 Bipar</a></nav>`;
}

function page(title: string, o: Options, body: string, refresh: boolean) {
  return shell({
    title, nonce: o.nonce, noScript: true, refreshSeconds: refresh ? o.refreshSeconds : undefined,
    extraHead: `<style nonce="${esc(o.nonce)}">${css}${o.healthBar && o.healthCss ? o.healthCss : ''}</style>`,
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
  const { lines, unmapped } = buildPrintQueue(queue, map, o.now);
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

function packingCard(c: PackingCard, map: ComponentMap, next: boolean) {
  const name = (id: string) => text(Object.hasOwn(map.componentes, id) ? map.componentes[id]!.nome : id);
  const checks = Object.entries(c.parts).filter(([, n]) => n > 0)
    .map(([id, n]) => `<label class="check"><input type="checkbox"> ${n}× ${name(id)}</label>`).join('');
  const names = c.nameValidation.names.length ? `<div class="note"><strong>Nomes:</strong> ${c.nameValidation.names.map(text).join(', ')}</div>` : '';
  const others = c.items.filter(i => i.resolution.kind === 'other').map(i => `<label class="check"><input type="checkbox"> ${i.quantity}× ${text(i.productAttr || i.productName)}</label>`).join('');
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
  const { proximo, fila, travados, embalados } = buildPackingQueue(queue, map, o.now);
  return page('Bancada de embalagem', o, `
    <p class="muted">O primeiro é o liberado com prazo mais curto. Marque cada peça ao colocar na embalagem e bipe a etiqueta no fim para conferir. Esta página não atualiza sozinha, para não apagar as marcações.</p>
    <section><h2>Próximo a embalar</h2>${proximo ? packingCard(proximo, map, true) : '<p>Nenhum pedido liberado para embalar.</p>'}</section>
    <section><h2>Depois (${fila.length})</h2>${fila.map(c => packingCard(c, map, false)).join('') || '<p>Fila vazia.</p>'}</section>
    <section><h2>Não enviar ainda (${travados.length})</h2>${travados.map(c => packingCard(c, map, false)).join('') || '<p>Nenhum pedido travado.</p>'}</section>
    <p class="muted">${embalados} pedido(s) já embalado(s), aguardando coleta.</p>`, false);
}
