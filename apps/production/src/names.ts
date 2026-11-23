import { cleanText } from '../../collector/src/orders-view.js';

const enumeration = /^\d+\s*[-.)º°:]?\s*/;
const conjunction = / e /i;
const suspicious = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|@)/i;
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const knownLabel = /nome|bolinha|coracao|mao|grinch|rotulo|kit|personaliza|unidade/;
const placeholders = new Set(['ok', 'sim', 'nao', 'sem nome', 'sem nomes', 'n/a', 'na', 'obrigado', 'obrigada', 'nome', 'nomes', 'x', 'teste']);

export function parseNames(note: string | null | undefined): { names: string[]; flags: string[] } {
  const flags = new Set<string>();
  if (suspicious.test(note ?? '')) flags.add('texto_suspeito');
  const raw = (note ?? '').split(/[\r\n,;|]|(?<!\bn)\/|\/(?!a\b)/i).map(token => token.trim()).filter(Boolean);
  const tokens = raw.map(token => {
    const colon = token.lastIndexOf(':');
    if (colon < 0 || (enumeration.test(token) && /^\d+\s*$/.test(token.slice(0, colon)))) return token;
    if (!knownLabel.test(fold(token.slice(0, colon)))) flags.add('rotulo_removido');
    return token.slice(colon + 1).trim();
  }).filter(Boolean);
  const enumerated = tokens.every(token => enumeration.test(token) && token.replace(enumeration, '') !== '');
  const names = tokens.flatMap((token, index) => {
    const cleaned = cleanText(enumerated ? token.replace(enumeration, '') : token);
    if (/ - |[()[\]]/.test(cleaned)) flags.add('texto_extra');
    const split = cleaned.split(conjunction);
    if (index >= 1 && index === tokens.length - 1 && split.length === 2) {
      flags.add('conjuncao_dividida');
      return split.map(cleanText);
    }
    if (split.length > 1) flags.add('nome_composto_com_e');
    return [cleaned];
  }).filter(Boolean);
  const seen = new Set<string>();
  for (const name of names) {
    const folded = fold(name);
    if (!/\p{L}/u.test(name) || placeholders.has(folded)) flags.add('placeholder');
    if (seen.has(folded)) flags.add('nome_repetido');
    seen.add(folded);
    if (/\d/.test(name)) flags.add('contem_numero');
    if (name.length > 30 || name.split(' ').length > 3) flags.add('texto_longo');
  }
  return { names, flags: [...flags] };
}

export const nameStatuses = ['sem_nomes', 'quantidade_divergente', 'revisar', 'completo', 'nao_aplicavel'] as const;
type NameStatus = typeof nameStatuses[number];

export function validateNames(note: string | null | undefined, expected: number, opts: { personalizedLines?: number; unmappedChristmas?: boolean; mappingPending?: boolean; hasOtherItems?: boolean } = {}) {
  const { names, flags } = expected === 0 ? { names: [], flags: [] } : parseNames(note);
  const found = names.length;
  const reasons = [...flags];
  let status: NameStatus = 'completo';
  if (expected === 0) status = 'nao_aplicavel';
  else if (!cleanText(note)) status = 'sem_nomes';
  else if (found !== expected) {
    status = 'quantidade_divergente';
    reasons.push(`encontrados ${found} de ${expected}`);
  } else if (flags.length) status = 'revisar';
  if ((opts.personalizedLines ?? 0) > 1) reasons.push('distribuição por item não verificada');
  if (opts.mappingPending && status === 'completo') reasons.push('mapa a confirmar');
  if (opts.hasOtherItems) reasons.push('pedido com itens não natalinos');
  if (opts.unmappedChristmas) {
    reasons.push('mapeamento pendente');
    if (status === 'nao_aplicavel') status = 'revisar';
  }
  if (status === 'completo' && reasons.length) status = 'revisar';
  return { status, expected, found, names, reasons };
}
