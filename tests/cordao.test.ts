import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../apps/collector/src/core.js';
import { buildProductionQueue } from '../apps/collector/src/operational.js';
import { renderProduction } from '../apps/panel/src/render-production.js';
import { isConsumable, loadComponentMap, resolveItem, validateComponentMap } from '../apps/production/src/component-map.js';
import { buildProductionView } from '../apps/production/src/production.js';

const map = loadComponentMap(), now = Date.parse('2026-11-23T12:00Z');
const hand = '228815352485', mix = '239429290388', elves = '239429290386';
function item(variationId: string, productCount = 1) {
  const variant = map.variantes[variationId]!;
  return { variationId, productCount, productId: variant.productId, productName: variant.anuncio, productAttr: variant.variante };
}
function order(orderNumber: string, orderItemList: ReturnType<typeof item>[], packed = false) {
  return {
    ...normalize({ orderNumber, orderItemList }),
    queues: [packed ? 'TO_PICKUP' : 'TO_SHIP'] as ('TO_PICKUP' | 'TO_SHIP')[],
  };
}

test('hand, mixed and double elf kits each count one cord per piece', () => {
  const queue = buildProductionQueue([order('A', [item(hand)]), order('B', [item(mix)]), order('C', [item(elves, 2)])], now);
  const resolutions = queue.orders.map(order => resolveItem(order.items[0]!, map)).map(result => {
    assert.equal(result.kind, 'mapped');
    return [result.parts, result.expectedNames];
  });
  assert.deepEqual(resolutions, [
    [{ mao_coracao: 6, cordao_vermelho: 6 }, 6],
    [{ biscoito: 2, elfo: 2, cordao_vermelho: 4 }, 0],
    [{ elfo: 8, cordao_vermelho: 8 }, 0],
  ]);
});

test('mixed orders count pending and packed cords and render consumables after printed parts', () => {
  const handItem = item(hand);
  const queue = buildProductionQueue([
    order('A', [handItem, item(mix)]),
    order('B', [item(elves, 2)], true),
    order('C', [{ ...handItem, productName: 'Kit com 4 bolinhas Natal Grinch' }]),
  ], now);
  const { orders, totals } = buildProductionView(queue, map, now);
  assert.equal(orders[0]?.expectedNames, 6);
  assert.equal(orders[0]?.parts.cordao_vermelho, 10);
  assert.deepEqual(totals.aProduzir, { mao_coracao: 12, mao_bolinha: 0, biscoito: 2, elfo: 2, cordao_vermelho: 16 });
  assert.equal(totals.jaEmbalados.cordao_vermelho, 8);
  assert.equal(totals.unconfirmedParts.cordao_vermelho, 6);
  const page = renderProduction(queue, map, [], { now, timezone: 'America/Sao_Paulo', nonce: 'test', listHref: '/' });
  assert.match(page, /Elfo natalino<\/th>.*Consumíveis \(não impressos\)<\/th>.*Cordão vermelho<\/th><td>16 .*\(6 a confirmar\).*<td>8<\/td>/);
  assert.match(page, /6× Mão Grinch coração \+ 6× Cordão vermelho/);
});

test('unmapped hand and mixed kit suggestions include cords when defined in the map', () => {
  const queue = buildProductionQueue([order('A', [
    { ...item(hand), variationId: 'unknown-hand' }, { ...item(mix), variationId: 'unknown-mix' },
  ])], now);
  assert.deepEqual(buildProductionView(queue, map, now).unmapped.map(v => v.guess), [
    { mao_coracao: 6, cordao_vermelho: 6 }, { biscoito: 2, elfo: 2, cordao_vermelho: 4 },
  ]);
});

test('real component map applies the cord rule to every variant', () => {
  assert.equal(map.versao, 3);
  assert.equal(isConsumable(map, 'cordao_vermelho'), true);
  for (const variant of Object.values(map.variantes)) {
    const printed = Object.entries(variant.componentes).filter(([id]) => !isConsumable(map, id));
    assert.equal(variant.componentes.cordao_vermelho, printed.reduce((sum, [, count]) => sum + count, 0));
  }
});

test('component map rejects wrong and missing cord counts and personalized consumables', () => {
  const variant = map.variantes[hand]!;
  for (const componentes of [{ mao_coracao: 6, cordao_vermelho: 5 }, { mao_coracao: 6 }]) {
    assert.throws(() => validateComponentMap({ ...map, variantes: { [hand]: { ...variant, componentes } } }), /COMPONENT_MAP_INVALID/);
  }
  assert.throws(() => validateComponentMap({
    ...map, componentes: { ...map.componentes, mao_coracao: { ...map.componentes.mao_coracao, consumivel: true } },
  }), /COMPONENT_MAP_INVALID/);
});
