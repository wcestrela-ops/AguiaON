import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSubdomainSlug } from '../shared/tenantResolver';

test('extractSubdomainSlug: extrai o slug de um subdomínio válido', () => {
  assert.equal(extractSubdomainSlug('loja1.ag-on.com', 'ag-on.com'), 'loja1');
});

test('extractSubdomainSlug: ignora a porta no host', () => {
  assert.equal(extractSubdomainSlug('loja1.ag-on.com:3000', 'ag-on.com'), 'loja1');
});

test('extractSubdomainSlug: retorna null para o próprio domínio base', () => {
  assert.equal(extractSubdomainSlug('ag-on.com', 'ag-on.com'), null);
});

test('extractSubdomainSlug: retorna null para www do domínio base', () => {
  assert.equal(extractSubdomainSlug('www.ag-on.com', 'ag-on.com'), null);
});

test('extractSubdomainSlug: retorna null para host que não é subdomínio da base', () => {
  assert.equal(extractSubdomainSlug('outrodominio.com.br', 'ag-on.com'), null);
});

test('extractSubdomainSlug: retorna null para mais de um nível de subdomínio', () => {
  assert.equal(extractSubdomainSlug('a.b.ag-on.com', 'ag-on.com'), null);
});

test('extractSubdomainSlug: retorna null quando hostHeader ou baseDomain estão vazios', () => {
  assert.equal(extractSubdomainSlug('', 'ag-on.com'), null);
  assert.equal(extractSubdomainSlug('loja1.ag-on.com', ''), null);
});

test('extractSubdomainSlug: é case-insensitive', () => {
  assert.equal(extractSubdomainSlug('LOJA1.AG-ON.COM', 'ag-on.com'), 'loja1');
});
