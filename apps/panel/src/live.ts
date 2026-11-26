import { createHash } from 'node:crypto';
import type { Device, PackedMap } from '../../production/src/packing-store.js';

/**
 * Sincronia entre celulares do Embalar/Produção. O registro já é um só (no servidor); o que faltava
 * era a tela de cada celular saber que mudou. Aqui ficam:
 *  - quem está com qual pedido aberto agora ("está embalando"), só em memória, 15 min no máximo;
 *  - o resumo que cada celular consulta a cada poucos segundos (/ao-vivo.json).
 */
export const WORKING_TTL_MS = 15 * 60 * 1000;
/** Pedido → aparelhos com ele aberto agora (pode ser mais de um: aí todos são avisados). */
export type Working = Map<string, { device: Device; desde: number }[]>;

function prune(working: Working, now: number, dropDevice?: string) {
  for (const [k, list] of working) {
    const keep = list.filter(w => w.device.id !== dropDevice && now - w.desde <= WORKING_TTL_MS);
    if (keep.length) working.set(k, keep); else working.delete(k);
  }
}
/** Marca que este aparelho abriu o pedido (e solta o que ele tinha aberto antes). Sem key: só solta. */
export function claimOrder(working: Working, key: string | null, device: Device, now: number) {
  prune(working, now, device.id);
  if (key) working.set(key, [...(working.get(key) ?? []), { device, desde: now }]);
}
/** O pedido foi embalado: ninguém mais está com ele aberto. */
export const releaseOrder = (working: Working, key: string) => { working.delete(key); };
/** Valor seguro dentro de <script>: JSON sem "<" cru (não fecha a tag). */
const js = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export const whoLabel = (d: Device | undefined) => d ? (d.nome ? d.nome : `aparelho ${d.id}`) : 'outro celular';

export type LiveState = {
  /** Versão do Embalar (pedidos embalados, quem está embalando, fila). */
  v: string;
  /** Versão da Produção: a do Embalar mais as etapas marcadas. */
  vp: string;
  embalados: Record<string, { por: string; hora: string; meu: boolean }>;
  /** por: quem MAIS (além de mim) está com o pedido aberto; outros: quantos. */
  andamento: Record<string, { por: string; outros: number; desde: string; meu: boolean }>;
  contagem: Record<string, number>;
  fila: string[];
};

export function liveState(o: {
  packed: PackedMap; working: Working; now: number; me: string | null; timezone: string;
  contagem: Record<string, number>; fila: string[]; extra?: unknown;
}): LiveState {
  const hora = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: o.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const embalados: LiveState['embalados'] = {};
  for (const [k, r] of o.packed) embalados[k] = { por: whoLabel(r.dispositivo), hora: hora(r.embaladoEm), meu: !!o.me && r.dispositivo?.id === o.me };
  const andamento: LiveState['andamento'] = {};
  prune(o.working, o.now);
  for (const [k, list] of o.working) {
    if (o.packed.has(k)) { o.working.delete(k); continue; }
    const others = list.filter(w => w.device.id !== o.me);
    andamento[k] = { por: others.map(w => whoLabel(w.device)).join(' e '), outros: others.length,
      desde: new Date(Math.min(...list.map(w => w.desde))).toISOString(), meu: others.length < list.length };
  }
  // A versão muda quando qualquer coisa que a tela mostra muda; o celular compara e se atualiza.
  const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('base64url').slice(0, 16);
  const v = hash([[...o.packed.keys()].sort(), Object.keys(andamento).sort().map(k => [k, o.working.get(k)!.map(w => w.device.id).sort()]), o.fila]);
  return { v, vp: hash([v, o.extra ?? null]), embalados, andamento, contagem: o.contagem, fila: o.fila };
}

/**
 * Script do celular: consulta /ao-vivo.json a cada 5 s (e ao voltar para a aba) e atualiza a tela.
 * mode 'fila': marca na lista quem está embalando e o que já foi embalado, sem recarregar (não fecha a câmera).
 * mode 'pedido': na tela de perguntas, avisa se outro celular abriu ou embalou o mesmo pedido.
 * mode 'pagina': recarrega quando algo mudou (Embalados, Histórico, Produção) — na Produção, só se nada estiver marcado.
 * Só usa textContent: nada vindo do servidor vira HTML.
 */
export function liveScript(o: { url: string; mode: 'fila' | 'pedido' | 'pagina'; v: string; key?: string; field?: 'v' | 'vp' }) {
  return `(()=>{const U=${js(o.url)},M=${js(o.mode)},K=${js(o.key ?? '')},F=${js(o.field ?? 'v')};let V=${js(o.v)},busy=false;
const bar=document.getElementById('live');
function show(msg,cls,reload){if(!bar)return;bar.className='live '+cls;bar.textContent=msg;bar.hidden=false;if(reload){bar.setAttribute('role','button');bar.onclick=()=>location.reload()}}
function tag(a,msg,cls){let b=a.querySelector('.livetag');if(!b){b=document.createElement('div');(a.querySelector('.id')||a.firstElementChild).after(b)}b.className='livetag '+cls;b.textContent=msg}
function apply(d){
for(const [k,n] of Object.entries(d.contagem||{}))document.querySelectorAll('[data-count="'+k+'"]').forEach(e=>{e.textContent=String(n)});
if(M==='fila'){const seen=new Set();document.querySelectorAll('article[data-key]').forEach(a=>{const k=a.dataset.key;seen.add(k);const p=d.embalados[k],w=d.andamento[k];
 if(p){a.classList.add('gone');tag(a,'✅ Embalado por '+p.por+' às '+p.hora,'ok');a.querySelectorAll('button').forEach(x=>{x.disabled=true})}
 else if(w&&w.outros>0)tag(a,'🔒 '+w.por+(w.outros>1?' estão':' está')+' embalando agora','warn');else{const b=a.querySelector('.livetag');if(b)b.remove()}});
 if((d.fila||[]).some(k=>!seen.has(k)))show('🔄 Chegaram pedidos novos. Toque aqui para atualizar.','info',true)}
else if(M==='pedido'&&K){const p=d.embalados[K],w=d.andamento[K];
 if(p&&!p.meu){show('⛔ '+p.por+' acabou de embalar este pedido às '+p.hora+'. Não embale de novo.','bad');document.querySelectorAll('form[data-confirm] button').forEach(x=>{x.disabled=true})}
 else if(w&&w.outros>0)show('⚠️ '+w.por+' também '+(w.outros>1?'abriram':'abriu')+' este pedido agora. Combine antes de embalar.','warn');else if(bar&&!p)bar.hidden=true}
else if(M==='pagina'&&d[F]!==V){if(document.querySelector('input[type=checkbox]:checked'))show('🔄 Outro celular atualizou. Salve o que marcou e toque aqui.','info',true);else location.reload()}
V=d[F]}
async function tick(){if(busy||document.hidden)return;busy=true;try{const r=await fetch(U,{cache:'no-store',credentials:'same-origin'});if(r.ok)apply(await r.json())}catch(e){}finally{busy=false}}
setInterval(tick,5000);document.addEventListener('visibilitychange',tick);window.addEventListener('pageshow',e=>{if(e.persisted)location.reload()});tick();})();`;
}

export const liveCss = `.live{position:sticky;top:0;z-index:5;border-radius:10px;padding:10px;margin:8px 0;font-weight:700}
.live.bad{background:var(--late);color:#fff}.live.warn{background:var(--urg);color:#1d1d1b}.live.info{background:var(--note);border:1px solid var(--noteline);cursor:pointer}
.livetag{border-radius:8px;padding:6px 8px;margin:6px 0;font-weight:700}.livetag.warn{background:var(--urg);color:#1d1d1b}.livetag.ok{background:var(--good)}
article.gone{opacity:.55}
button:disabled{opacity:.4;cursor:not-allowed}`;
