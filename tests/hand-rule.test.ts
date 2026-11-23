import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProductionQueue } from '../apps/collector/src/operational.js';
import { normalize } from '../apps/collector/src/core.js';
import { guessFromText, handTypeFromTitle, loadComponentMap, resolveItem, validateComponentMap } from '../apps/production/src/component-map.js';
import { buildProductionView } from '../apps/production/src/production.js';
import { renderProduction } from '../apps/panel/src/render-production.js';

// Marcos, 23/11: "Kit 4 Bolinha" (singular) = mão CORAÇÃO; "Kit com 4 bolinhas" (plural) = mão BOLINHA.
const now = Date.parse('2026-11-23T12:00:00Z');
const singular = 'Kit 4 Bolinha de Natal Grinch', plural = 'Kit com 4 bolinhas Natal Grinch';
const map = validateComponentMap({
  versao: 2,
  componentes: { mao_coracao: { nome: 'Mão Grinch coração', personalizado: true }, mao_bolinha: { nome: 'Mão Grinch bolinha', personalizado: true } },
  deteccaoNatal: ['natal', 'grinch'],
  variantes: {
    c6: { productId: 'pc', anuncio: singular, variante: '6 unidades', componentes: { mao_coracao: 6 }, confirmado: true },
    b4: { productId: 'pb', anuncio: plural, variante: '4un', componentes: { mao_bolinha: 4 }, confirmado: true },
  },
});
function order(id: string, productId: string, variationId: string, productName: string, productAttr: string, note: string | null, qty = 1) {
  return { ...normalize({ orderNumber: id, orderComment: note, orderTimeoutTime: (now + 72 * 3600000) / 1000,
    orderItemList: [{ productId, variationId, productName, productAttr, productCount: qty }] }), queues: ['TO_SHIP'] as ('TO_SHIP')[] };
}
const view = (...o: ReturnType<typeof order>[]) => buildProductionView(buildProductionQueue(o, now), map, now);

test('regra das mãos: "bolinha" no singular → mão coração', () => {
  assert.equal(handTypeFromTitle(singular).type, 'mao_coracao');
  assert.equal(handTypeFromTitle(singular).ambiguous, false);
  assert.deepEqual(guessFromText(singular, '6 unidades'), { mao_coracao: 6 });
  const v = view(order('S1', 'pc', 'c6', singular, '6 unidades', 'Ana, Bia, Caio, Duda, Enzo, Lara'));
  assert.equal(v.totals.aProduzir.mao_coracao, 6);
  assert.equal(v.totals.aProduzir.mao_bolinha, 0);
  assert.equal(v.orders[0]!.nameValidation.status, 'completo');
});

test('regra das mãos: "bolinhas" no plural → mão bolinha', () => {
  assert.equal(handTypeFromTitle(plural).type, 'mao_bolinha');
  assert.deepEqual(guessFromText(plural, '5 unidades'), { mao_bolinha: 5 });
  const v = view(order('P1', 'pb', 'b4', plural, '4un', 'Ana / Bia / Caio / Duda'));
  assert.equal(v.totals.aProduzir.mao_bolinha, 4);
  assert.equal(v.totals.aProduzir.mao_coracao, 0);
  assert.equal(v.orders[0]!.nameValidation.status, 'completo');
});

test('regra das mãos: maiúsculas, acentos e espaços não mudam o resultado', () => {
  for (const t of ['KIT 4 BOLINHA DE NATAL GRINCH', 'kit 4 bolinha de natal', 'Kit 4  Bolínha', 'Kit 4 bolinha.']) assert.equal(handTypeFromTitle(t).type, 'mao_coracao', t);
  for (const t of ['KIT COM 4 BOLINHAS NATAL', 'kit com quatro bolinhas', 'Kit com 4 Bolínhas', 'Bolinhas!']) assert.equal(handTypeFromTitle(t).type, 'mao_bolinha', t);
  for (const t of ['Kit enfeite de natal Biscoito Ginger, Elfo', 'Bolinhão de Natal', '', null]) assert.equal(handTypeFromTitle(t).type, null, String(t));
});

test('regra das mãos: título com as duas formas é ambíguo e nunca conta como completo', () => {
  const both = 'Kit 4 Bolinha de Natal + Kit com 4 bolinhas';
  assert.deepEqual([handTypeFromTitle(both).type, handTypeFromTitle(both).ambiguous], [null, true]);
  assert.equal(guessFromText(both, '4 unidades'), null);
  // Mapped variant whose current title became ambiguous: flagged, sent to review.
  const v = view(order('A1', 'pc', 'c6', both, '6 unidades', 'Ana, Bia, Caio, Duda, Enzo, Lara'));
  const r = v.orders[0]!.items[0]!.resolution;
  assert.equal(r.kind === 'mapped' && r.titleMismatch, true);
  assert.equal(v.orders[0]!.mappingPending, true);
  assert.equal(v.orders[0]!.nameValidation.status, 'revisar');
});

test('regra das mãos: anúncio renomeado do singular para o plural é sinalizado', () => {
  const r = resolveItem(buildProductionQueue([order('R1', 'pc', 'c6', 'Kit com 4 bolinhas Natal Grinch', '6 unidades', null)], now).orders[0]!.items[0]!, map);
  assert.equal(r.kind === 'mapped' && r.titleMismatch, true);
  // Its parts are shown as "a confirmar", never silently counted as a confirmed hand.
  const v = view(order('R2', 'pc', 'c6', 'Kit com 4 bolinhas Natal Grinch', '6 unidades', null));
  assert.equal(v.totals.unconfirmedParts.mao_coracao, 6);
});

test('regra das mãos: unidades vêm da variação, nunca do "Kit 4" do título', () => {
  assert.deepEqual(guessFromText(singular, '2un'), { mao_coracao: 2 });
  assert.deepEqual(guessFromText(plural, '6 unidades'), { mao_bolinha: 6 });
  assert.equal(guessFromText(plural, 'Vermelho'), null); // no units in the variation: no guess, never 4
  const v = view(order('Q1', 'pc', 'c6', singular, '6 unidades', null, 2));
  assert.equal(v.totals.aProduzir.mao_coracao, 12);
  assert.equal(v.orders[0]!.expectedNames, 12);
});

test('regra das mãos: o mapa real segue a regra e está confirmado', () => {
  const real = loadComponentMap();
  const hands = Object.values(real.variantes).filter(v => v.componentes.mao_coracao || v.componentes.mao_bolinha);
  assert.ok(hands.length >= 14);
  for (const v of hands) {
    const type = handTypeFromTitle(v.anuncio).type;
    assert.ok(type && v.componentes[type], `${v.anuncio} / ${v.variante}`);
    assert.equal(Object.keys(v.componentes).length, 2);
    const units = Number(/(\d+)\s*un/i.exec(v.variante)?.[1]);
    assert.equal(v.componentes[type], units, v.variante);
    assert.equal(v.confirmado, true);
  }
  const byProduct = (id: string) => new Set(hands.filter(v => v.productId === id).map(v => Object.keys(v.componentes)[0]));
  assert.deepEqual([...byProduct('22599159010')], ['mao_coracao']);
  assert.deepEqual([...byProduct('23897993661')], ['mao_coracao']);
  assert.deepEqual([...byProduct('22799154331')], ['mao_bolinha']);
  assert.deepEqual([...byProduct('22093534214')], ['mao_bolinha']);
});

test('regra das mãos: a página mostra o título do anúncio ao lado do tipo de mão', () => {
  const q = buildProductionQueue([order('H1', 'pc', 'c6', singular, '6 unidades', null), order('H2', 'pb', 'b4', plural, '4un', null)], now);
  const html = renderProduction(q, map, [], { now, timezone: 'America/Sao_Paulo', nonce: 'N', listHref: '/p/x' });
  assert.match(html, /Anúncio: Kit 4 Bolinha de Natal Grinch · &quot;bolinha&quot; no singular → mão coração/);
  assert.match(html, /Anúncio: Kit com 4 bolinhas Natal Grinch · &quot;bolinhas&quot; no plural → mão bolinha/);
});
