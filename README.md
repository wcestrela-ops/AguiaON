# AguiaOn

Plataforma SaaS multi-tenant — hub central de identidade (SSO), marketplace de módulos e
integrações compartilhadas (WhatsApp/Evolution, pagamentos, **SMS**). Baseado no AG-ON,
com o gateway de SMS incorporado como capability de plataforma.

Ver `MODULO_INTEGRACAO.md` para o contrato de integração de módulos externos.

## Gateway de SMS

Capability de plataforma para envio de SMS, no mesmo padrão do WhatsApp/Evolution: qualquer
módulo chama `sendSms(...)` sem saber qual gateway físico está por trás.

- **Provedores suportados:** simulado (dev), Android (chip no aparelho), HTTP genérico
  (`%NUMBER%`/`%MESSAGE%` — compatível com GPSWOX/PHP/modems) e SMSMarket.
- **Compartilhado ou próprio:** cada lojista pode usar o gateway compartilhado da
  plataforma (`establishment_id = NULL`) ou cadastrar o próprio (`OWN`) — a cadeia de
  failover tenta primeiro o gateway do lojista, depois o compartilhado.
- **Código:** `src/shared/smsSender.ts` (lógica + failover) e `src/routes/adminSms.ts`
  (rotas `/admin/sms`).
- **Tabelas:** `sms_providers`, `sms_dispatches`, `sms_logs` — criadas automaticamente
  no primeiro uso (`ensureTables()`), sem precisar rodar migration manual. Ver
  `database/migration_v16_sms_gateway.sql` para referência do schema.

### Rotas

| Rota | Escopo | Descrição |
|------|--------|-----------|
| `GET /admin/sms/providers/schema` | SUPERADMIN | Campos de cada tipo de provedor (pra montar o form) |
| `GET /admin/sms` | SUPERADMIN | Lista gateways da plataforma |
| `POST /admin/sms` | SUPERADMIN | Cria gateway da plataforma |
| `PUT /admin/sms/:id` | SUPERADMIN | Atualiza gateway |
| `DELETE /admin/sms/:id` | SUPERADMIN | Remove gateway |
| `POST /admin/sms/:id/test` | SUPERADMIN | Testa configuração |
| `POST /admin/sms/send` | SUPERADMIN | Envio manual |
| `GET /admin/sms/dispatches` | SUPERADMIN | Histórico de envios |
| `GET /admin/sms/mine` | LOJISTA | Lista gateway(s) próprio(s) do lojista |
| `POST /admin/sms/mine` | LOJISTA | Cadastra gateway próprio (OWN) |
