import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, normalize } from '../apps/collector/src/core.js';
import { save } from '../apps/collector/src/output.js';
import { normalizeDeadline, calculatePriority, calculateHoursRemaining, buildProductionQueue, aggregateProduction, selectOperationalStage, operationalSummary } from '../apps/collector/src/operational.js';
const now = Date.parse('2026-10-08T12:00:00Z');
const raw = (id = 'A', hours: number | null = 3, productId = 'P', variationId: string | null = 'V', quantity = 2) => ({ orderNumber: id, orderTimeoutTime: hours === null ? null : (now + hours * 3600000) / 1000, buyerName: 'PRIVATE', buyerAccount: 'PRIVATE', buyerCountry: 'PRIVATE', CPF: 'PRIVATE', address: 'PRIVATE', phone: 'PRIVATE', trackingNumber: 'PRIVATE', cookies: 'PRIVATE', tokens: 'PRIVATE', headers: 'PRIVATE', JSESSIONID: 'PRIVATE', invoiceOurKey: 'PRIVATE', orderItemList: [{ productId, variationId, productName: 'Produto exemplo', productAttr: 'Azul', productCount: quantity, buyerName: 'PRIVATE' }] });
const order = (id = 'A', hours: number | null = 3, productId = 'P', variationId: string | null = 'V', quantity = 2) => ({ ...normalize(raw(id, hours, productId, variationId, quantity)), queues: ['TO_SHIP' as const] });
for (const [hours, expected] of [[-2,'OVERDUE'],[0,'OVERDUE'],[3,'CRITICAL'],[12,'URGENT'],[36,'ATTENTION'],[72,'NORMAL'],[null,'UNKNOWN'],[6,'CRITICAL'],[24,'URGENT'],[48,'ATTENTION']] as const) test(`priority ${hours} hours -> ${expected}`, () => assert.equal(calculatePriority(hours === null ? null : now + hours * 3600000, now), expected));
test('sorts all priorities and puts UNKNOWN last', () => assert.deepEqual(buildProductionQueue([order('u',null),order('n',72),order('a',36),order('r',12),order('c',3),order('o',-1)],now).orders.map(o=>o.orderNumber),['o','c','r','a','n','u']));
test('sorts deadlines within a priority',()=>assert.deepEqual(buildProductionQueue([order('b',5),order('a',2)],now).orders.map(o=>o.orderNumber),['a','b']));
test('overlapping queues count units once globally',async()=>{ const r=await collect(async profile=>({orders:profile==='TO_INVOICE'||profile==='TO_SHIP'?[normalize(raw())]:[],total:profile==='TO_INVOICE'||profile==='TO_SHIP'?1:0}),1000,now);assert.equal(r.productionSummary.totals.units,2);assert.deepEqual(r.productionQueue.orders[0]!.queues,['TO_INVOICE','TO_SHIP']); });
test('same product and variation consolidate two orders',()=>{const p=aggregateProduction(buildProductionQueue([order(),order('B')],now)).products;assert.equal(p.length,1);assert.equal(p[0]!.totalQuantity,4);assert.equal(p[0]!.orderCount,2);});
test('same names with different IDs remain separate',()=>assert.equal(aggregateProduction(buildProductionQueue([order(),order('B',3,'Q')],now)).products.length,2));
test('aggregate highest priority',()=>assert.equal(aggregateProduction(buildProductionQueue([order('A',12),order('B',3)],now)).products[0]!.highestPriority,'CRITICAL'));
test('aggregate nearest deadline',()=>assert.equal(aggregateProduction(buildProductionQueue([order('A',5),order('B',3)],now)).products[0]!.nearestDeadline,new Date(now+3*3600000).toISOString()));
test('production queue allowlist rejects nested PII',()=>assert.equal(JSON.stringify(buildProductionQueue([order()],now)).includes('PRIVATE'),false));
test('production summary allowlist rejects PII',()=>assert.equal(JSON.stringify(aggregateProduction(buildProductionQueue([order()],now))).includes('PRIVATE'),false));
test('timezone independent absolute hours',()=>{for(const zone of ['UTC','America/Sao_Paulo','Asia/Tokyo']) assert.equal(calculateHoursRemaining(normalizeDeadline((now+3*3600000)/1000,null,zone).deadlineEpoch,now),3);});
test('invalid deadlines fail safe',()=>{for(const value of ['invalid',NaN,Infinity,-1,{},true]) assert.equal(normalizeDeadline(value,null).deadlineEpoch,null);});
test('injectable now is deterministic',()=>{assert.deepEqual(buildProductionQueue([order()],now),buildProductionQueue([order()],now));assert.equal(buildProductionQueue([order()],now+3600000).orders[0]!.hoursRemaining,2);});
test('seconds and milliseconds normalize equally',()=>assert.deepEqual(normalizeDeadline(now/1000,null),normalizeDeadline(now,null)));
test('local deadline uses business timezone',()=>assert.equal(normalizeDeadline(null,'2026-10-08 09:00:00').deadlineEpoch,now));
test('timestamp disagreement fails safe with sanitized code',()=>assert.deepEqual(normalizeDeadline(now/1000,'2026-10-08 10:00:00'),{deadline:null,deadlineEpoch:null,deadlineWarning:'DEADLINE_MISMATCH'}));
test('matching timestamp and local text accepted',()=>assert.equal(normalizeDeadline(now/1000,'2026-10-08 09:00').deadlineEpoch,now));
test('impossible dates and DST gaps or ambiguity rejected',()=>{for(const value of ['2026-02-30 10:00','2026-03-08 02:30','2026-11-01 01:30']) assert.equal(normalizeDeadline(null,value,'America/New_York').deadlineEpoch,null);});
test('missing variation never merges distinct unresolved items',()=>assert.equal(aggregateProduction(buildProductionQueue([order('A',3,'P',null),order('B',3,'P',null)],now)).products.length,2));
test('stages follow blocking precedence',()=>{assert.equal(selectOperationalStage(['TO_PICKUP','TO_PRINT','TO_SHIP','TO_INVOICE']),'NEEDS_INVOICE');assert.equal(selectOperationalStage(['TO_PRINT','TO_SHIP']),'NEEDS_SHIPPING');assert.equal(selectOperationalStage(['TO_PICKUP','TO_PRINT']),'NEEDS_PRINT_PROCESSING');assert.equal(selectOperationalStage(['TO_PICKUP']),'NEEDS_PICKUP');});
test('product ties sort by descending quantity even with unknown deadlines',()=>assert.deepEqual(aggregateProduction(buildProductionQueue([order('A',null,'P','V',1),order('B',null,'Q','V',5)],now)).products.map(p=>p.totalQuantity),[5,1]));
test('top N limits terminal products',()=>{const s=aggregateProduction(buildProductionQueue([order(),order('B',12,'Q')],now));assert.equal((operationalSummary(s,'America/Sao_Paulo',1).match(/ un/g)??[]).length,1);assert.throws(()=>operationalSummary(s,'UTC',-1));});
for(const name of ['summary','production-queue','production-summary']) test(`${name}.json replaced through atomic snapshot`,async()=>{const dir=await mkdtemp(join(tmpdir(),'operational-'));try{const first=await collect(async p=>({orders:p==='TO_SHIP'?[normalize(raw())]:[],total:p==='TO_SHIP'?1:0}),1000,now);await save(first,dir);const previous=await readlink(join(dir,'.current'));const empty=await collect(async()=>({orders:[],total:0}),1000,now+1);await save(empty,dir);assert.notEqual(await readlink(join(dir,'.current')),previous);assert.equal(await readlink(join(dir,`${name}.json`)),`.current/${name}.json`);const value=JSON.parse(await readFile(join(dir,`${name}.json`),'utf8'));assert.deepEqual(value,name==='summary'?empty.summary:name==='production-queue'?empty.productionQueue:empty.productionSummary);}finally{await rm(dir,{recursive:true,force:true});}});
test('failed publication preserves previous snapshot',async()=>{const dir=await mkdtemp(join(tmpdir(),'operational-'));try{const result=await collect(async()=>({orders:[],total:0}),1000,now);await save(result,dir);const previous=await readlink(join(dir,'.current'));await unlink(join(dir,'production-summary.json'));await writeFile(join(dir,'production-summary.json'),'occupied');await assert.rejects(save(result,dir));assert.equal(await readlink(join(dir,'.current')),previous);}finally{await rm(dir,{recursive:true,force:true});}});

for (const [text, epoch] of [
  ['05/10/2026 23:59', Date.UTC(2026, 9, 6, 2, 59)],
  ['08/10/2026 22:36', Date.UTC(2026, 9, 9, 1, 36)],
] as const) {
  test(`real Brazilian deadline ${text} uses Sao Paulo timezone`, () => {
    assert.deepEqual(normalizeDeadline(null, text, 'America/Sao_Paulo'), {
      deadline: new Date(epoch).toISOString(), deadlineEpoch: epoch, deadlineWarning: null,
    });
  });
  test(`reconciles epoch seconds and milliseconds with ${text}`, () => {
    for (const delta of [-1000, -1, 0, 1000, 59000, 59999]) {
      for (const timestamp of [epoch + delta, (epoch + delta) / 1000, String((epoch + delta) / 1000)]) {
        assert.deepEqual(normalizeDeadline(timestamp, text), {
          deadline: new Date(epoch + delta).toISOString(), deadlineEpoch: epoch + delta, deadlineWarning: null,
        });
      }
    }
  });
  test(`real divergences with ${text} fail safe`, () => {
    for (const delta of [-3600000, -60000, -1001, 60000, 3600000]) {
      assert.deepEqual(normalizeDeadline(epoch + delta, text), {
        deadline: null, deadlineEpoch: null, deadlineWarning: 'DEADLINE_MISMATCH',
      });
    }
  });
}
test('Brazilian deadline syntax is strict', () => {
  for (const text of ['5/10/2026 23:59', '05/1/2026 23:59', '05/10/26 23:59', '05/10/2026 3:59', '05/10/2026 23:9', '05/10/2026 23:59:00', '05/10/2026T23:59', ' 05/10/2026 23:59', '05/10/2026 23:59 ', '05/10/2026 23:59Z', '05/10/2026 23:59\n']) {
    assert.equal(normalizeDeadline(null, text).deadlineWarning, 'INVALID_DEADLINE_TEXT', text);
  }
});
test('Brazilian calendar and clock components reject impossible dates', () => {
  for (const text of ['00/10/2026 23:59', '32/10/2026 23:59', '31/04/2026 23:59', '29/02/2026 23:59', '29/02/2100 23:59', '05/00/2026 23:59', '05/13/2026 23:59', '05/10/0000 23:59', '05/10/2026 24:00', '05/10/2026 23:60']) {
    assert.deepEqual(normalizeDeadline(now, text), { deadline: null, deadlineEpoch: null, deadlineWarning: 'INVALID_DEADLINE_TEXT' }, text);
  }
  assert.equal(normalizeDeadline(null, '29/02/2024 23:59').deadlineEpoch, Date.UTC(2024, 2, 1, 2, 59));
});
test('Brazilian text honors configured timezone and rejects DST gaps and ambiguity', () => {
  assert.equal(normalizeDeadline(null, '08/10/2026 22:36', 'UTC').deadlineEpoch, Date.UTC(2026, 9, 8, 22, 36));
  for (const text of ['08/03/2026 02:30', '01/11/2026 01:30']) {
    assert.equal(normalizeDeadline(null, text, 'America/New_York').deadlineWarning, 'INVALID_DEADLINE_TEXT');
  }
});
test('one-second boundary tolerance requires minute-only text', () => {
  const epoch = Date.UTC(2026, 9, 9, 1, 35, 59);
  assert.equal(normalizeDeadline(epoch, '2026-10-08 22:36').deadlineEpoch, epoch);
  assert.equal(normalizeDeadline(epoch, '2026-10-08 22:36:00').deadlineWarning, 'DEADLINE_MISMATCH');
});
test('invalid epoch still fails safe with valid Brazilian text', () => {
  assert.equal(normalizeDeadline('invalid', '08/10/2026 22:36').deadlineWarning, 'INVALID_DEADLINE');
});
test('real Brazilian fields flow through order normalization into priority', () => {
  const epoch = Date.UTC(2026, 9, 9, 1, 36, 59);
  const normalized = normalize({ ...raw(), orderTimeoutTime: epoch / 1000, orderTimeoutTimeStr: '08/10/2026 22:36' });
  assert.equal(normalized.deadlineWarning, null);
  assert.equal(normalized.deadlineEpoch, epoch);
  assert.equal(calculatePriority(normalized.deadlineEpoch, epoch - 3 * 3600000), 'CRITICAL');
});
