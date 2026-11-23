import type { Queue } from '../../collector/src/notifications.js';
import { cleanText, formatRemaining, platformLabel, stageLabel } from '../../collector/src/orders-view.js';
import type { ComponentMap } from '../../production/src/component-map.js';
import { nameStatuses } from '../../production/src/names.js';
import { buildProductionView } from '../../production/src/production.js';
import { computeSyncHealth, type History } from '../../production/src/sync-health.js';
import { esc, shell, time } from './render.js';

const text = (value: string | null | undefined) => esc(cleanText(value));
const labels = {
  sem_nomes: 'sem nomes', quantidade_divergente: 'divergente', revisar: 'revisar',
  completo: 'completo (contagem confere)', nao_aplicavel: 'não aplicável',
};
const css = `
.production{overflow-wrap:anywhere}
.production h2{font-size:18px;margin:22px 0 8px}
.production table{width:100%;border-collapse:collapse;background:var(--card);text-align:left}
.production th,.production td{padding:6px;border-bottom:1px solid var(--line)}
.production .chips{flex-wrap:wrap}
.production .chip[aria-current="true"]{border-color:var(--ink);font-weight:bold}
.production .banner{font-weight:bold;background:var(--note);border:1px solid var(--noteline);border-radius:10px;padding:8px}
.production .sync-stale{background:var(--note);border:1px solid var(--urg);border-radius:10px;padding:8px}
`;

function syncSection(health: ReturnType<typeof computeSyncHealth>, timezone: string) {
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const lastRead = (value: string | null) => value ? date.format(Date.parse(value)).replace(',', '') : '—';
  const errorLabel = (error: string | null) => {
    if (!error) return '—';
    if (/AUTH|SESSION_EXPIRED|sess[aã]o expirada/i.test(error)) return 'login expirou';
    return /^[A-Z][A-Z_]{1,63}$/.test(error) ? esc(error) : 'falha na leitura';
  };
  const rows = Object.values(health.accounts).map(account => `
    <div class="${account.absent ? 'sync-stale' : account.down ? 'alert' : account.stale ? 'sync-stale' : 'card'}">
      <strong>${text(account.name)} · ${account.absent ? 'ausente na última coleta' : account.down ? 'caída' : 'OK'}</strong>${account.stale ? ' · leitura desatualizada' : ''}
      <div>Última leitura OK: ${esc(lastRead(account.lastOkAt))} · Falhas seguidas: ${account.failureStreak} · Erro: ${errorLabel(account.lastError)}</div>
    </div>`).join('');
  return `<section><h2>Saúde da sincronização</h2>
    <p class="${health.snapshotStale ? 'sync-stale' : 'muted'}">
      ${health.latestGeneratedAt ? `Coleta de ${Math.floor(health.snapshotAgeMinutes ?? 0)} min atrás${health.snapshotStale ? ` · nenhuma coleta nova desde ${esc(time(Date.parse(health.latestGeneratedAt), timezone))}` : ''}` : 'Sem informações de coleta'}
    </p>
    ${rows || '<p>Sem informações por conta.</p>'}
    <p class="muted">Quando todas as contas falham, só a idade da coleta indica que os dados estão desatualizados.</p>
  </section>`;
}

type Options = { now: number; timezone: string; nonce: string; envLabel?: string; listHref: string; refreshSeconds?: number; historyUnavailable?: boolean; nameFilter?: string | null };

export function renderProduction(queue: Queue, map: ComponentMap, history: History[], o: Options) {
  const { orders, totals, nameCounts, unmapped } = buildProductionView(queue, map, o.now);
  const health = computeSyncHealth([...history, { generatedAt: queue.generatedAt, accounts: queue.accounts }], o.now);
  const componentName = (id: string) => text(Object.hasOwn(map.componentes, id) ? map.componentes[id]!.nome : id);
  const parts = (counts: Record<string, number>) => Object.entries(counts).map(([id, count]) => `${count}× ${componentName(id)}`).join(' + ');
  const rows = Object.keys(map.componentes).map(id => `<tr><th scope="row">${componentName(id)}</th><td>${totals.aProduzir[id]}${totals.unconfirmedParts[id] ? ` <span class="muted">(${totals.unconfirmedParts[id]} a confirmar)</span>` : ''}</td><td>${totals.jaEmbalados[id]}</td></tr>`).join('');
  const filter = nameStatuses.find(status => status === o.nameFilter);
  const chips = nameStatuses.map(status =>
    `<a class="chip" href="?nomes=${status}"${filter === status ? ' aria-current="true"' : ''}>${labels[status]} <b>${nameCounts[status]}</b></a>`
  ).join('');
  const cards = orders.filter(order => !filter || order.nameValidation.status === filter).map(order => {
    const names = order.nameValidation;
    const items = order.items.map(item => {
      const r = item.resolution;
      const breakdown = r.kind === 'mapped' ? ` → ${parts(r.parts)}${r.attrChanged ? ' · variante mudou, revisar mapa' : ''}` : r.kind === 'unmapped_christmas' ? ' · sem mapa' : '';
      return `<li>${item.quantity}× ${text(item.productAttr || item.productName)}${breakdown}</li>`;
    }).join('');
    const platformClass = order.platform === 'shopee' || order.platform === 'tiktok' ? order.platform : 'other';
    return `<article class="card p-${order.livePriority}">
      <header><span class="badge ${platformClass}">${text(platformLabel(order.platform))}</span>
        ${order.account ? `<span class="acct">${text(order.account)}</span>` : ''}
        <span class="due">${esc(formatRemaining(order.liveHours))}</span></header>
      <div class="id">${text(order.displayId)}</div>
      <div class="muted">${esc(stageLabel(order.stage, order.printLabelState))}</div>
      ${order.packed ? '<span class="acct">embalado</span>' : ''} ${order.mappingPending ? '<span class="acct">mapa a confirmar</span>' : ''}
      <ul>${items}</ul>
      <div class="note"><strong>Nomes: ${labels[names.status]}</strong> · ${names.found} encontrados de ${names.expected} esperados
        ${names.names.length ? `<div>${names.names.map(text).join(', ')}</div>` : ''}
        ${names.reasons.length ? `<div>${names.reasons.map(text).join(' · ')}</div>` : ''}
      </div>
      ${names.status !== 'completo' && names.status !== 'nao_aplicavel' ? `<div class="muted">Nota: ${text(order.note) || '—'}</div>` : ''}
    </article>`;
  }).join('');
  const variants = unmapped.map(v => `<li>${text(v.productName)}${v.productAttr ? ` · ${text(v.productAttr)}` : ''}
    ${v.variationId ? ` · variante ${text(v.variationId)}` : ''} · ${v.orderCount} pedido(s)
    ${v.reason ? ` · ${text(v.reason)}` : ''}${v.guess ? ` · sugestão: ${parts(v.guess)}` : ''}</li>`).join('');
  return shell({
    title: 'Produção', nonce: o.nonce, noScript: true, refreshSeconds: o.refreshSeconds,
    extraHead: `<style nonce="${esc(o.nonce)}">${css}</style>`,
    body: `<main class="production">
      <div class="titlebar"><h1>Central de Produção</h1><a class="btn" href="${esc(o.listHref)}">Pedidos</a></div>
      ${o.envLabel ? `<div class="banner">${text(o.envLabel)}</div>` : ''}
      ${syncSection(health, o.timezone)}
      ${o.historyUnavailable ? '<p class="sync-stale">Histórico indisponível: falhas seguidas podem estar subestimadas</p>' : ''}
      <section><h2>Peças a produzir</h2>
        <table><thead><tr><th scope="col">Peça</th><th scope="col">A produzir</th><th scope="col">Já embaladas</th></tr></thead><tbody>${rows}</tbody></table>
      </section>
      <section><h2>Nomes</h2><div class="chips">${filter ? '<a class="chip" href="?">Todos</a>' : ''}${chips}</div></section>
      <section><h2>Pedidos natalinos</h2>${cards || (filter ? '<p>Nenhum pedido com esse status de nomes.</p>' : '<p>Nenhum pedido natalino.</p>')}</section>
      <section><h2>Variantes natalinas sem mapa</h2>${variants ? `<p>Peças não contadas até o Marcos confirmar.</p><ul>${variants}</ul>` : '<p>Nenhuma variante sem mapa.</p>'}</section>
    </main>`,
  });
}
