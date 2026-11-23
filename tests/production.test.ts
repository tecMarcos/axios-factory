import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProductionQueue } from '../apps/collector/src/operational.js';
import { normalize } from '../apps/collector/src/core.js';
import { guessFromText, loadComponentMap, resolveItem, validateComponentMap } from '../apps/production/src/component-map.js';
import { buildProductionView } from '../apps/production/src/production.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const variants = {
  v4: ['4un', { mao_bolinha: 4 }, true],
  v5: ['5un', { mao_bolinha: 5 }, false],
  v6: ['6 unidades', { mao_bolinha: 6 }, true],
  mix: ['Misto', { biscoito: 2, elfo: 2 }, true],
  cookies: ['4 Biscoitos', { biscoito: 4 }, true],
  elves: ['4 Elfos', { elfo: 4 }, true],
} as const;
const map = validateComponentMap({
  versao: 1,
  componentes: {
    mao_bolinha: { nome: 'Bolinha', personalizado: true },
    biscoito: { nome: 'Biscoito', personalizado: false },
    elfo: { nome: 'Elfo', personalizado: false },
  },
  deteccaoNatal: ['natal', 'grinch'],
  variantes: Object.fromEntries(Object.entries(variants).map(([id, [variante, componentes, confirmado]]) =>
    [id, { productId: 'p1', anuncio: 'Kit Natal', variante, componentes, confirmado }])),
});

function order(id: string, variant: keyof typeof variants, quantity: number, note: string | null, hours = 72) {
  return { ...normalize({
    orderNumber: id, orderComment: note, orderTimeoutTime: (now + hours * 3600000) / 1000,
    orderItemList: [{ productId: 'p1', variationId: variant, productName: 'Kit com 4 bolinhas Natal', productAttr: variants[variant][0], productCount: quantity }],
  }), queues: ['TO_SHIP'] as ('TO_SHIP' | 'TO_PRINT' | 'TO_PICKUP')[] };
}
const view = (...orders: ReturnType<typeof order>[]) => buildProductionView(buildProductionQueue(orders, now), map, now);

test('counts personalized kits by component and quantity, tracking unconfirmed parts', () => {
  const result = view(
    order('A', 'v4', 1, 'Ana, Bia, Caio, Duda'),
    order('B', 'v6', 1, 'Ana, Bia, Caio, Duda, Eva, Fábio'),
    order('C', 'v5', 2, 'Ana, Bia, Caio, Duda, Eva, Fábio, Gabi, Hugo, Iara, João'),
    order('D', 'v4', 1, null), order('E', 'v4', 1, 'Ana, Bia, Caio'),
  );
  assert.deepEqual(result.orders.map(o => o.expectedNames), [4, 6, 10, 4, 4]);
  assert.deepEqual(result.orders.map(o => o.parts.mao_bolinha), [4, 6, 10, 4, 4]);
  assert.deepEqual(result.orders.map(o => o.nameValidation.status), ['completo', 'completo', 'revisar', 'sem_nomes', 'quantidade_divergente']);
  assert.equal(result.totals.aProduzir.mao_bolinha, 28);
  assert.equal(result.totals.unconfirmedParts.mao_bolinha, 10);
  assert.equal(result.orders[2]!.mappingPending, true);
});

test('counts mixed, cookie and elf kits and ignores notes for them', () => {
  const result = view(order('A', 'mix', 1, 'Ana'), order('B', 'cookies', 2, null), order('C', 'elves', 3, null));
  assert.deepEqual(result.orders.map(o => [o.parts.biscoito, o.parts.elfo]), [[2, 2], [8, 0], [0, 12]]);
  assert.equal(result.nameCounts.nao_aplicavel, 3);
});

test('live priority, packed totals, repeated snapshots and cancelled orders', () => {
  const normal = order('A', 'v4', 1, null);
  const critical = { ...order('B', 'v6', 1, null, 3), queues: ['TO_SHIP', 'TO_PRINT'] as typeof normal.queues };
  const packed = { ...order('C', 'v5', 2, null), queues: ['TO_PICKUP'] as typeof normal.queues };
  const queue = buildProductionQueue([normal, critical, critical, packed], now);
  const first = buildProductionView(queue, map, now);
  assert.deepEqual(first, buildProductionView(queue, map, now));
  assert.deepEqual(first.orders.map(o => [o.orderNumber, o.livePriority, o.packed]), [['B', 'CRITICAL', false], ['A', 'NORMAL', false], ['C', 'NORMAL', true]]);
  assert.equal(first.totals.aProduzir.mao_bolinha, 10);
  assert.equal(first.totals.jaEmbalados.mao_bolinha, 10);
  assert.equal(first.totals.unconfirmedParts.mao_bolinha, 0);
  const next = buildProductionQueue([critical, packed], now + 60000);
  assert.equal(buildProductionView(next, map, now + 60000).totals.aProduzir.mao_bolinha, 6);
  assert.equal(view().totals.aProduzir.mao_bolinha, 0);
});

test('unknown Christmas variants are suggested once per order and excluded from totals', () => {
  const queue = buildProductionQueue([order('A', 'v4', 1, null), order('B', 'v4', 1, null), order('C', 'v4', 1, null)], now);
  const item = { ...queue.orders[0]!.items[0]!, variationId: 'unknown', productAttr: '6 unidades' };
  queue.orders[0]!.items = [item, item];
  queue.orders[1]!.items = [item];
  queue.orders[2]!.items = [{ ...item, productName: 'Caneca' }];
  const result = buildProductionView(queue, map, now);
  assert.equal(result.orders.length, 2);
  assert.equal(result.nameCounts.revisar, 2);
  assert.deepEqual(result.orders[0]!.nameValidation.reasons, ['mapeamento pendente']);
  assert.equal(result.totals.aProduzir.mao_bolinha, 0);
  assert.deepEqual(result.unmapped.map(v => [v.variationId, v.orderCount, v.guess]), [['unknown', 2, { mao_bolinha: 6 }]]);
});

test('checks both IDs and flags changed attributes after folding', () => {
  const item = buildProductionQueue([order('A', 'v6', 1, null)], now).orders[0]!.items[0]!;
  for (const [productAttr, changed] of [[' 6   UNIDÁDES ', false], ['7 unidades', true]] as const) {
    const r = resolveItem({ ...item, productAttr }, map);
    assert.equal(r.kind, 'mapped');
    if (r.kind === 'mapped') assert.equal(r.attrChanged, changed);
  }
  assert.equal(resolveItem({ ...item, productId: 'p2' }, map).kind, 'unmapped_christmas');
  assert.deepEqual(guessFromText('Kit Bolinhas', '5 un'), { mao_bolinha: 5 });
  // Hands are told apart only by "bolinha" (singular = coração) vs "bolinhas" (plural); units only from the variation.
  assert.deepEqual(guessFromText('Kit 4 Bolinha de Natal', '3un'), { mao_coracao: 3 });
  assert.equal(guessFromText('Kit 4 Bolinha de Natal', null), null);
  assert.equal(guessFromText('Enfeite Coração', '3un'), null);
  assert.deepEqual(guessFromText('Kit 4 biscoto', null), { biscoito: 4 });
  assert.deepEqual(guessFromText('Kit 4 Biscoitos', 'Kit 4 Elfos'), { elfo: 4 });
  assert.deepEqual(guessFromText('Kit Natal', 'Misto'), { biscoito: 2, elfo: 2 });
  assert.equal(guessFromText('Kit Natal', null), null);
});

test('strict map validation rejects bad entries and accepts the shipped config', () => {
  const good = map.variantes.v4!;
  for (const variant of [{ ...good, productId: undefined }, { ...good, componentes: { missing: 1 } },
    ...[0, -1, 1.5, '4'].map(count => ({ ...good, componentes: { mao_bolinha: count } })),
  ]) assert.throws(() => validateComponentMap({ ...map, variantes: { v4: variant } }), /COMPONENT_MAP_INVALID/);
  const entries = Object.values(loadComponentMap().variantes);
  assert.ok(entries.length && entries.every(entry => Object.keys(entry.componentes).length));
});
