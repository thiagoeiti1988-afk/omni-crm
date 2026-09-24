import { timingSafeEqual } from 'crypto';

// Bearer token simples (Fase 1). Fase 5 troca por JWT por org.
// Por design, sem MCP_API_KEY configurado o servidor recusa TUDO —
// nunca cai em "modo aberto" por omissão de env var.
export function isAuthorized(req: Request): boolean {
  const expected = process.env.MCP_API_KEY;
  if (!expected) return false;

  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;

  const provided = match[1];
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
