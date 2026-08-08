import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLimit } from '../shared/platformBilling';

test('checkLimit: dentro do limite retorna null', () => {
  assert.equal(checkLimit({ max_vehicles: 5 }, 'max_vehicles', 3), null);
});

test('checkLimit: no limite exato (contagem == máximo) bloqueia', () => {
  assert.notEqual(checkLimit({ max_vehicles: 5 }, 'max_vehicles', 5), null);
});

test('checkLimit: acima do limite bloqueia', () => {
  const msg = checkLimit({ max_vehicles: 5 }, 'max_vehicles', 9);
  assert.equal(typeof msg, 'string');
  assert.match(msg as string, /Limite do plano atingido/);
});

test('checkLimit: chave sem limite definido = ilimitado', () => {
  assert.equal(checkLimit({}, 'max_vehicles', 1000), null);
});

test('checkLimit: limite explicitamente null = ilimitado', () => {
  assert.equal(checkLimit({ max_vehicles: null as any }, 'max_vehicles', 1000), null);
});

test('checkLimit: limite zero bloqueia qualquer criação', () => {
  const msg = checkLimit({ max_vehicles: 0 }, 'max_vehicles', 0);
  assert.notEqual(msg, null);
});
