import { priorities, type Priority } from '../../collector/src/operational.js';
import type { Queue } from '../../collector/src/notifications.js';
import { cleanText, defaultPersonalizationKeywords, displayOrderId, formatRemaining, groupByPriority, marketplaceUrl, personalizationStatus, platformLabel, priorityLabels, stageLabel, type LiveOrder } from '../../collector/src/orders-view.js';

export type RenderOptions = { now: number; timezone: string; nonce: string; personalizationKeywords?: string[]; refreshSeconds?: number; scanHref?: string };
type CardOptions = { timezone: string; personalizationKeywords: string[]; large?: boolean };

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (epoch: number, timeZone: string) => new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(epoch);
const dateTime = (epoch: number, timeZone: string) => new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(epoch);
const openByDefault: Priority[] = ['OVERDUE', 'CRITICAL', 'URGENT', 'ATTENTION'];

const css = `
:root{--bg:#f4f4f1;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--late:#c62828;--crit:#e0533d;--urg:#e09a1f;--att:#c9b200;--ok:#3f8f4f;--note:#fff6d6;--noteline:#e8cf6a;--miss:#fde7e7;--shopee:#ee4d2d;--tiktok:#111;--good:#e5f4e8}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#f2f1ec;--muted:#a3a29b;--line:#33332f;--note:#3a3320;--noteline:#7a6a2a;--miss:#4a2222;--tiktok:#f2f1ec;--good:#1f3a25}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.top{position:sticky;top:0;z-index:2;background:var(--bg);padding:14px 16px 8px;border-bottom:1px solid var(--line)}
.titlebar{display:flex;align-items:center;gap:10px;justify-content:space-between}
h1{font-size:20px;margin:0 0 2px}.muted{color:var(--muted);font-size:14px}.stale{color:var(--late);font-weight:600}
.chips{display:flex;gap:8px;overflow-x:auto;padding:10px 0 4px;scrollbar-width:none}.chip{flex:none;text-decoration:none;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px}
.chip.warn{border-color:var(--late);color:var(--late)}
main{padding:8px 16px 40px;max-width:720px;margin:0 auto}
.group{margin:14px 0}.group>summary{font-weight:700;font-size:18px;padding:8px 0;cursor:pointer;list-style:none}.group>summary::-webkit-details-marker{display:none}
.count{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:0 9px;font-size:14px;margin-left:4px}
.card{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--ok);border-radius:12px;padding:12px 14px;margin:10px 0}
.p-OVERDUE{border-left-color:var(--late)}.p-CRITICAL{border-left-color:var(--crit)}.p-URGENT{border-left-color:var(--urg)}.p-ATTENTION{border-left-color:var(--att)}.p-UNKNOWN{border-left-color:var(--muted)}
.card header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.due{margin-left:auto;font-weight:700;font-size:14px}.p-OVERDUE .due{color:var(--late)}
.acct{border:1px solid var(--line);border-radius:6px;padding:1px 7px;font-size:13px;font-weight:600}
.alert{background:var(--miss);border:1px solid var(--late);border-radius:10px;padding:10px 12px;margin:10px 0 2px;font-size:15px}
.badge{color:#fff;background:var(--muted);border-radius:6px;padding:2px 8px;font-size:13px;font-weight:700}.badge.shopee{background:var(--shopee)}.badge.tiktok{background:var(--tiktok);color:var(--bg)}
.id{display:flex;align-items:center;gap:8px;margin:8px 0 2px;font:600 17px/1.2 ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.note{margin:10px 0 4px;background:var(--note);border:1px solid var(--noteline);border-radius:8px;padding:8px 10px;font-size:16px;word-break:break-word}
.note.missing{background:var(--miss);border-color:var(--late);color:var(--ink)}
.large .note{font-size:22px;padding:12px 14px}.large .note strong{display:block;font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.items{list-style:none;margin:10px 0 0;padding:0}.item{display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--line)}
.item img,.noimg{width:56px;height:56px;border-radius:8px;object-fit:cover;flex:none;background:var(--bg);display:grid;place-items:center;font-size:24px}.sku{font-size:12px}
.large .item{padding:10px 0;align-items:center}.large .item img,.large .noimg{width:112px;height:112px}.large .item .what{font-size:18px}
.check{display:flex;align-items:center;gap:12px;width:100%;cursor:pointer}.check input{width:28px;height:28px;flex:none;accent-color:var(--ok)}
.item.done{background:var(--good);border-radius:8px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
button,.btn{font:inherit;font-size:15px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);padding:8px 12px;min-height:40px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.btn{background:var(--ink);color:var(--bg);border-color:var(--ink)}.btn.ghost{background:var(--bg);color:var(--ink);border-color:var(--line)}
.btn.big{width:100%;min-height:56px;font-size:18px;font-weight:700}
.id button{font-size:13px;min-height:32px;padding:4px 10px}
.empty{text-align:center;padding:48px 16px;color:var(--muted)}
.banner{border-radius:12px;padding:14px 16px;font-size:20px;font-weight:700;margin:12px 0}.banner.ok{background:var(--good)}.banner.bad{background:var(--miss)}
.viewer{position:relative;background:#000;border-radius:12px;overflow:hidden;aspect-ratio:3/4;max-height:60vh;margin:12px 0}
.viewer video{width:100%;height:100%;object-fit:cover;display:block}
.viewer .aim{position:absolute;inset:32% 6%;border:3px solid rgba(255,255,255,.85);border-radius:12px;box-shadow:0 0 0 999px rgba(0,0,0,.25);pointer-events:none}
.viewer .hint{position:absolute;left:0;right:0;bottom:10px;text-align:center;color:#fff;font-size:14px;text-shadow:0 1px 2px #000}
.manual{display:flex;gap:8px;margin-top:8px}.manual input{flex:1;font:inherit;font-size:16px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-width:0}
`;

const copyScript = `
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]'); if (!b) return;
  var t = b.getAttribute('data-copy'), old = b.textContent;
  var done = function () { b.textContent = 'Copiado ✓'; setTimeout(function () { b.textContent = old; }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, function () { prompt('Copie:', t); }); else prompt('Copie:', t);
});
document.addEventListener('change', function (e) {
  var c = e.target.closest('.check input'); if (!c) return;
  c.closest('.item').classList.toggle('done', c.checked);
  var all = document.querySelectorAll('.check input'), ok = document.querySelectorAll('.check input:checked');
  var s = document.getElementById('checked'); if (s) s.textContent = ok.length === all.length ? '✅ Tudo conferido' : ok.length + ' de ' + all.length + ' conferidos';
});`;

export function shell(o: { title: string; nonce: string; body: string; script?: string; refreshSeconds?: number; extraHead?: string }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
${o.refreshSeconds ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : ''}
<title>${esc(o.title)} — Axios Factory</title>
<style nonce="${esc(o.nonce)}">${css}</style>
${o.extraHead ?? ''}
</head>
<body>
${o.body}
<script nonce="${esc(o.nonce)}">${copyScript}${o.script ?? ''}</script>
</body>
</html>`;
}

export function card(order: LiveOrder, o: CardOptions) {
  const status = personalizationStatus(order, o.personalizationKeywords);
  const link = marketplaceUrl(order), platform = platformLabel(order.platform), id = displayOrderId(order);
  const note = cleanText(order.note);
  const size = o.large ? 112 : 56;
  const items = order.items.map(item => {
    const body = `
          ${item.productImg ? `<img src="${esc(item.productImg)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="${size}" height="${size}">` : '<span class="noimg" aria-hidden="true">📦</span>'}
          <div class="what"><strong>${esc(item.quantity)}×</strong> ${esc(cleanText(item.productName))}
            ${item.productAttr ? `<div class="muted">${esc(cleanText(item.productAttr))}</div>` : ''}
            ${item.productSku ? `<div class="muted sku">SKU ${esc(cleanText(item.productSku))}</div>` : ''}</div>`;
    return o.large
      ? `<li class="item"><label class="check"><input type="checkbox" aria-label="Conferido">${body}</label></li>`
      : `<li class="item">${body}</li>`;
  }).join('');
  const noteBlock = status === 'MISSING'
    ? '<div class="note missing">⚠️ <strong>Falta o nome</strong> — coloque a personalização na nota do UpSeller</div>'
    : note ? `<div class="note">✏️ <strong>Nota:</strong> ${esc(note)}</div>` : '';
  return `
    <article class="card p-${order.livePriority}${status === 'MISSING' ? ' flag' : ''}${o.large ? ' large' : ''}">
      <header>
        <span class="badge ${esc(order.platform ?? 'other')}">${esc(platform)}</span>
        ${order.account ? `<span class="acct">${esc(cleanText(order.account))}</span>` : ''}
        ${order.shopName ? `<span class="muted shop">${esc(cleanText(order.shopName))}</span>` : ''}
        <span class="due">${esc(formatRemaining(order.liveHours))}</span>
      </header>
      <div class="id"><span>${esc(id)}</span><button type="button" data-copy="${esc(id)}">Copiar</button></div>
      <div class="muted">${esc(stageLabel(order.operationalStage, order.printLabelState))}${order.deadlineEpoch !== null ? ` · prazo ${esc(dateTime(order.deadlineEpoch, o.timezone))}` : ''}</div>
      ${noteBlock}
      <ul class="items">${items}</ul>
      ${o.large ? `<p class="muted" id="checked">Toque em cada item ao conferir</p>` : ''}
      <div class="actions">
        ${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Abrir ${order.platform === 'shopee' ? 'na' : 'no'} ${esc(platform)}</a>` : ''}
        ${order.platformOrderId && order.orderNumber !== order.platformOrderId ? `<button type="button" class="btn ghost" data-copy="${esc(order.orderNumber)}">Copiar nº UpSeller</button>` : ''}
      </div>
    </article>`;
}

export function renderPanel(queue: Queue, options: RenderOptions): string {
  const o = { ...options, personalizationKeywords: options.personalizationKeywords ?? defaultPersonalizationKeywords, refreshSeconds: options.refreshSeconds ?? 120 };
  const groups = groupByPriority(queue, o.now);
  const generated = Date.parse(queue.generatedAt), ageMin = Math.max(0, Math.round((o.now - generated) / 60000));
  const missing = queue.orders.filter(order => personalizationStatus(order, o.personalizationKeywords) === 'MISSING').length;
  const chips = priorities.filter(p => groups.get(p)!.length).map(p => `<a class="chip c-${p}" href="#${p}">${priorityLabels[p].icon} ${esc(priorityLabels[p].title)} <b>${groups.get(p)!.length}</b></a>`).join('');
  const sections = priorities.filter(p => groups.get(p)!.length).map(p => `
  <details id="${p}" class="group"${openByDefault.includes(p) ? ' open' : ''}>
    <summary>${priorityLabels[p].icon} ${esc(priorityLabels[p].title)} <span class="count">${groups.get(p)!.length}</span></summary>
    ${groups.get(p)!.map(order => card(order, o)).join('')}
  </details>`).join('');
  return shell({
    title: 'Pedidos', nonce: o.nonce, refreshSeconds: o.refreshSeconds,
    body: `
<div class="top">
  <div class="titlebar"><h1>Pedidos para produzir</h1>${o.scanHref ? `<a class="btn" href="${esc(o.scanHref)}">📷 Bipar</a>` : ''}</div>
  <div class="muted">${queue.orders.length} pedidos · atualizado às ${esc(time(generated, o.timezone))}${ageMin >= 90 ? ` · <span class="stale">dados de ${ageMin} min atrás</span>` : ageMin > 0 ? ` (há ${ageMin} min)` : ''}</div>
  ${accountAlerts(queue)}
  <nav class="chips">${missing ? `<a class="chip warn" href="#${esc(firstMissingSection(groups, o.personalizationKeywords))}">⚠️ Sem nome <b>${missing}</b></a>` : ''}${chips}</nav>
</div>
<main>
${sections || '<p class="empty">Nenhum pedido pendente agora. 🎉</p>'}
</main>`,
  });
}

/** An account whose collection failed (usually an expired login) is missing from the list: say so loudly. */
export function accountAlerts(queue: Queue) {
  return (queue.accounts ?? []).filter(a => !a.ok).map(a => `<div class="alert">⚠️ <strong>Conta ${esc(cleanText(a.name))}</strong>: ${a.error === 'AUTH_REQUIRED' || a.error === 'API_REJECTED_OR_SESSION_EXPIRED' ? 'o login no UpSeller expirou' : 'não foi possível ler os pedidos'}. Os pedidos dessa conta não aparecem aqui.</div>`).join('');
}

function firstMissingSection(groups: ReturnType<typeof groupByPriority>, keywords: string[]) {
  return priorities.find(p => groups.get(p)!.some(order => personalizationStatus(order, keywords) === 'MISSING')) ?? 'OVERDUE';
}
