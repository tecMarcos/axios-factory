import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cronômetro oculto do Embalar. Quando o pedido abre (bipado ou escolhido na lista), a página leva
 * um carimbo de hora assinado pelo servidor, preso ao pedido e ao aparelho. Ao salvar "embalado",
 * o servidor confere a assinatura e calcula quanto tempo passou. Nada roda no celular e o carimbo
 * não pode ser trocado por outro pedido ou aparelho. Se o painel reiniciar no meio, aquele pedido
 * fica sem tempo (não inventa número).
 */
export function createPackTimer(secret: Buffer = randomBytes(32)) {
  const sign = (at: number, key: string, device: string) =>
    createHmac('sha256', secret).update(`${at}\n${key}\n${device}`).digest('base64url').slice(0, 32);
  return {
    start(key: string, device: string, now: number) {
      const at = Math.floor(now);
      return `${at}.${sign(at, key, device)}`;
    },
    /** Segundos desde a abertura, ou null se o carimbo não vale para este pedido/aparelho. */
    elapsed(token: string | null | undefined, key: string, device: string, now: number): number | null {
      const m = /^(\d{10,16})\.([A-Za-z0-9_-]{32})$/.exec(token ?? '');
      if (!m) return null;
      const at = Number(m[1]);
      const expected = Buffer.from(sign(at, key, device));
      const got = Buffer.from(m[2]!);
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
      if (at > now + 5000 || now - at > 7 * 86400000) return null;
      return Math.max(0, (now - at) / 1000);
    },
  };
}
