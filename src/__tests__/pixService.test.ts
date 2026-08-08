import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentChain } from '../shared/pixService';

test('buildPaymentChain: usa o método preferido primeiro quando configurado', () => {
  const chain = buildPaymentChain({
    preferred_payment_method: 'mercadopago',
    asaas_api_key: 'asaas-key',
    mp_access_token: 'mp-token',
    pix_key_value: '11999999999',
  });
  assert.deepEqual(chain, ['mercadopago', 'asaas', 'manual_pix']);
});

test('buildPaymentChain: pula o preferido se não estiver configurado, cai no fallback', () => {
  const chain = buildPaymentChain({
    preferred_payment_method: 'mercadopago',
    asaas_api_key: 'asaas-key',
    mp_access_token: '', // MP preferido mas sem token
    pix_key_value: '11999999999',
  });
  assert.deepEqual(chain, ['asaas', 'manual_pix']);
});

test('buildPaymentChain: normaliza "mp" para "mercadopago"', () => {
  const chain = buildPaymentChain({
    preferred_payment_method: 'mp',
    mp_access_token: 'mp-token',
  });
  assert.deepEqual(chain, ['mercadopago']);
});

test('buildPaymentChain: retorna cadeia vazia se nada estiver configurado', () => {
  const chain = buildPaymentChain({ preferred_payment_method: 'asaas' });
  assert.deepEqual(chain, []);
});

test('buildPaymentChain: não duplica o método preferido na cadeia de fallback', () => {
  const chain = buildPaymentChain({
    preferred_payment_method: 'asaas',
    asaas_api_key: 'asaas-key',
    mp_access_token: 'mp-token',
  });
  assert.deepEqual(chain, ['asaas', 'mercadopago']);
  assert.equal(chain.filter(m => m === 'asaas').length, 1);
});

test('buildPaymentChain: sem preferência definida, assume manual_pix como preferido', () => {
  const chain = buildPaymentChain({
    asaas_api_key: 'asaas-key',
    pix_key_value: '11999999999',
  });
  // manual_pix é o default de preferred_payment_method; como está configurado, vem primeiro
  assert.deepEqual(chain, ['manual_pix', 'asaas']);
});
