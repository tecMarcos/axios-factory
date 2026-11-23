import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNames, validateNames } from '../apps/production/src/names.js';

test('parses labels, conjunctions, delimiters, compound names and complete enumerations', () => {
  for (const note of ['Nomes das bolinhas: A, B, C, D', 'A, B, C e D', 'A / B; C | D', 'Grupo: A, B\nOutro: C, D']) {
    const result = validateNames(note, 4);
    assert.equal(result.status, / e |Grupo:/.test(note) ? 'revisar' : 'completo');
    assert.deepEqual(result.names, ['A', 'B', 'C', 'D']);
  }
  for (const note of ['1 Ana\n2 Bia', '1: Ana\n2: Bia', 'Nomes: 1. Ana\nNomes: 2º Bia']) {
    assert.deepEqual(parseNames(note), { names: ['Ana', 'Bia'], flags: [] });
  }
  assert.deepEqual(parseNames('Nomes: Ana Clara, Lívia').names, ['Ana Clara', 'Lívia']);
});

test('reports off-looking names and count mismatches without editing names', () => {
  const compound = validateNames('Ana e Pedro', 2);
  assert.equal(compound.status, 'quantidade_divergente');
  assert.ok(compound.reasons.includes('nome_composto_com_e'));
  assert.equal(validateNames('A, B e C', 2).status, 'quantidade_divergente');
  assert.deepEqual(validateNames('Ana, Bia, Caio', 4).reasons, ['encontrados 3 de 4']);
  assert.equal(validateNames('  ', 4).status, 'sem_nomes');
  for (const [note, flag] of [
    ['Ana - texto', 'texto_extra'], ['Ana (texto)', 'texto_extra'], ['1: Ana, Bia', 'contem_numero'],
    ['Ana2', 'contem_numero'], ['Ana de Teste Silva', 'texto_longo'],
    ['ana@example.test', 'texto_suspeito'], ['https://example.test', 'texto_suspeito'],
  ] as const) assert.ok(parseNames(note).flags.includes(flag), note);
  assert.deepEqual(validateNames('Ana (texto)', 0), { status: 'nao_aplicavel', expected: 0, found: 0, names: [], reasons: [] });
  const multi = validateNames('Ana, Bia', 2, { personalizedLines: 2 });
  assert.equal(multi.status, 'revisar');
  assert.deepEqual(multi.reasons, ['distribuição por item não verificada']);
});
