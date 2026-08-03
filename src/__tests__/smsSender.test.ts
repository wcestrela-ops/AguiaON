import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskProvider, SmsProviderRow } from '../shared/smsSender';

test('normalizePhone: remove tudo que não é dígito', () => {
  assert.equal(normalizePhone('(85) 99999-9999'), '85999999999');
});

test('normalizePhone: retorna null para telefone vazio', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('abc'), null);
});

function baseProvider(config: Record<string, any>): SmsProviderRow {
  return {
    id: 'p1',
    establishment_id: null,
    provider: 'smsmarket',
    label: null,
    config,
    is_primary: false,
    priority: 100,
    status: 'unknown',
    active: true,
  };
}

test('maskProvider: mascara api_key deixando só os últimos 4 caracteres', () => {
  const masked = maskProvider(baseProvider({ api_key: 'sk_live_1234567890abcdef' }));
  assert.equal(masked.config.api_key.endsWith('cdef'), true);
  assert.equal(masked.config.api_key.includes('sk_live'), false);
});

test('maskProvider: chave curta vira apenas asteriscos', () => {
  const masked = maskProvider(baseProvider({ api_key: 'ab' }));
  assert.equal(masked.config.api_key, '****');
});

test('maskProvider: não quebra quando não há api_key', () => {
  const masked = maskProvider(baseProvider({ base_url: 'https://example.com' }));
  assert.equal(masked.config.api_key, undefined);
  assert.equal(masked.config.base_url, 'https://example.com');
});
