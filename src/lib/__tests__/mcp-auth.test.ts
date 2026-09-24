import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../mcp-auth';

function reqWithAuth(header: string | null) {
  const headers = new Headers();
  if (header !== null) headers.set('authorization', header);
  return new Request('http://localhost/api/mcp-server', { method: 'POST', headers });
}

test('recusa quando MCP_API_KEY não está configurada', () => {
  delete process.env.MCP_API_KEY;
  assert.equal(isAuthorized(reqWithAuth('Bearer qualquer-coisa')), false);
});

test('recusa request sem header Authorization', () => {
  process.env.MCP_API_KEY = 'segredo-123';
  assert.equal(isAuthorized(reqWithAuth(null)), false);
});

test('recusa token incorreto', () => {
  process.env.MCP_API_KEY = 'segredo-123';
  assert.equal(isAuthorized(reqWithAuth('Bearer errado')), false);
});

test('aceita Bearer token correto', () => {
  process.env.MCP_API_KEY = 'segredo-123';
  assert.equal(isAuthorized(reqWithAuth('Bearer segredo-123')), true);
});
