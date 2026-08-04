# Águia-ON Core — Guia de Integração de Módulos

Este documento descreve tudo que um módulo externo precisa saber para se integrar ao core Águia-ON.

---

## 1. O que é o Águia-ON Core?

O Águia-ON Core é o hub central de autenticação e identidade de um ecossistema SaaS multi-tenant.
Ele gerencia:
- Login único (SSO) para clientes, lojistas e o SuperAdmin
- Marketplace (vitrine de lojas e módulos)
- Roteamento de requisições para módulos externos via proxy reverso

O cliente faz login **uma única vez** no core e acessa todos os módulos sem logar novamente.

---

## 2. Como o módulo é registrado

No painel admin (`/admin-panel → Módulos`), o SuperAdmin cadastra o módulo com:

| Campo | Descrição |
|---|---|
| **Nome** | Nome exibido ao usuário |
| **Slug** | Identificador único na URL (ex: `agendamentos`) |
| **URL base** | Endereço do servidor do módulo (ex: `https://agenda.seudominio.com`) |
| **Ícone** | Classe Font Awesome (ex: `fa-calendar`) |

Após cadastrado, o módulo fica acessível em:
```
https://ag-on.com/m/{slug}/
```

Toda requisição feita para `/m/{slug}/*` é **transparentemente encaminhada** pelo core para a URL base do módulo.

---

## 3. SSO — Autenticação pelo Core

### Dois caminhos possíveis

| | Fluxo 1 — Pelo proxy | Fluxo 2 — Subdomínio direto |
|---|---|---|
| URL de acesso | `ag-on.com/m/{slug}/` | `agenda.ag-on.com` |
| Como autentica | Headers `x-user-*` injetados pelo proxy | Cookie `auth_token` (`Domain=.ag-on.com`) |
| Configuração no core | Zero | `COOKIE_DOMAIN=.ag-on.com` no `.env` |

No Fluxo 2 o core seta o cookie `auth_token` no login com `Domain=.ag-on.com`, então o browser o envia automaticamente para todos os subdomínios. O módulo valida o JWT do cookie com o mesmo `JWT_SECRET`.

### Como funciona

O cliente **já está logado** no core quando acessa o módulo. O core valida o token JWT e injeta as informações do usuário como **headers HTTP** em cada requisição encaminhada ao módulo.

### Headers injetados pelo proxy

```
x-user-id           UUID do usuário (ou "superadmin")
x-user-whatsapp     WhatsApp do usuário (pode estar vazio se entrou por email)
x-user-level        Role do usuário: CLIENT | LOJISTA | SUPERADMIN
x-establishment-id  UUID do estabelecimento vinculado (vazio se não tiver)
x-sso-source        Sempre "ag-on-core" (confirma que veio pelo proxy)
```

### Exemplo de leitura no módulo (Node.js/Express)

```js
app.get('/minha-rota', (req, res) => {
  const userId         = req.headers['x-user-id'];
  const whatsapp       = req.headers['x-user-whatsapp'];
  const role           = req.headers['x-user-level'];      // CLIENT | LOJISTA | SUPERADMIN
  const establishmentId = req.headers['x-establishment-id'];

  if (!userId || req.headers['x-sso-source'] !== 'ag-on-core') {
    return res.status(401).json({ error: 'Acesso direto não permitido.' });
  }

  res.json({ userId, role });
});
```

### Validação extra via API (opcional)

Se o módulo precisar validar o token JWT diretamente:

```
GET https://ag-on.com/auth/validate
Authorization: Bearer <token>
```

Resposta:
```json
{
  "valid": true,
  "user": {
    "userId": "uuid...",
    "whatsapp": "5511999990000",
    "role": "CLIENT",
    "establishmentId": "uuid..."
  }
}
```

---

## 4. Banco de Dados Compartilhado

Todos os módulos **compartilham o mesmo banco PostgreSQL** do core. O módulo pode ler/escrever diretamente nas tabelas do core, ou criar suas próprias tabelas no mesmo banco.

### Variável de conexão

```env
DATABASE_URL=postgres://usuario:senha@host:5432/nome_do_banco
```

### Tabelas do core disponíveis para o módulo

| Tabela | Descrição |
|---|---|
| `users` | Clientes finais (`id`, `whatsapp`, `email`, `full_name`, `establishment_id`) |
| `establishments` | Lojistas (`id`, `name`, `slug`, `owner_whatsapp`, `owner_email`, `plan`) |
| `modules` | Módulos cadastrados (`id`, `name`, `slug`, `config_url`) |
| `user_modules` | Controle de acesso: quais usuários têm acesso a qual módulo |
| `transactions` | Histórico de pagamentos (pode ser escrito pelo módulo) |
| `announcements` | Anúncios exibidos no portal do cliente |
| `global_settings` | Configurações globais: chaves de API, SMTP, Evolution, etc. |

### Consulta de exemplo: buscar dados do usuário logado

```sql
SELECT u.id, u.full_name, u.whatsapp, u.email, e.name AS establishment
FROM users u
LEFT JOIN establishments e ON e.id = u.establishment_id
WHERE u.id = $1
```

### Verificar se usuário tem acesso ao módulo

```sql
SELECT 1 FROM user_modules um
JOIN modules m ON m.id = um.module_id
WHERE um.user_id = $1
  AND m.slug = 'slug-do-modulo'
  AND um.is_active = true
  AND (um.expires_at IS NULL OR um.expires_at > NOW())
```

---

## 5. Estrutura JWT (caso o módulo valide por conta própria)

O token é assinado com `JWT_SECRET` (variável de ambiente do core).

```json
{
  "userId": "uuid-do-usuario",
  "whatsapp": "5511999990000",
  "role": "CLIENT",
  "establishmentId": "uuid-do-estabelecimento",
  "iat": 1712345678,
  "exp": 1712950478
}
```

**Roles possíveis:**
- `CLIENT` — cliente final
- `LOJISTA` — dono do estabelecimento
- `SUPERADMIN` — administrador da plataforma (userId = `"superadmin"`)

---

## 6. Endpoints do Core úteis para o módulo

### Autenticação
| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/auth/validate` | Valida um token JWT |
| `POST` | `/auth/refresh` | Renova o token |

### Dados públicos
| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/public/modules` | Lista módulos ativos |
| `GET` | `/public/establishments` | Lista lojas públicas |
| `GET` | `/public/establishments/:slug` | Dados de uma loja |

### Dados do cliente autenticado
| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/client/me` | Perfil do cliente logado |
| `GET` | `/client/modules` | Módulos que o cliente tem acesso |
| `GET` | `/client/transactions` | Histórico de transações |
| `GET` | `/client/announcements` | Anúncios ativos |

---

## 7. Registrar transações no core

O módulo pode gravar transações na tabela compartilhada para aparecerem no histórico do portal:

```sql
INSERT INTO transactions
  (user_id, module_id, establishment_id, amount, currency, status, description, gateway, gateway_ref)
VALUES
  ($1, $2, $3, $4, 'BRL', 'PAID', 'Descrição do serviço', 'nome_gateway', 'ref_externa')
```

---

## 8. Variáveis de ambiente

### No core (`ag-on-core/.env`)

```env
JWT_SECRET=string_aleatoria_longa      # assina todos os tokens
COOKIE_DOMAIN=.ag-on.com              # ponto antes = vale para subdomínios
```

### No módulo (ex: `agenda-ag-on/.env`)

```env
DATABASE_URL=postgres://...            # mesmo banco do core
JWT_SECRET=string_aleatoria_longa      # IGUAL ao core para validar tokens
CORE_URL=https://ag-on.com            # opcional, para redirects
MODULE_SLUG=agendamentos               # slug como cadastrado no painel admin
```

> `JWT_SECRET` **precisa ser idêntico** nos dois lados. O cookie só funciona via HTTPS em produção.

---

## 9. Checklist para lançar um módulo

- [ ] Módulo cadastrado no painel admin com slug e URL base corretos
- [ ] Módulo lendo os headers `x-user-id`, `x-user-level`, `x-establishment-id`
- [ ] Módulo verificando `x-sso-source === 'ag-on-core'` para bloquear acesso direto
- [ ] `DATABASE_URL` e `JWT_SECRET` iguais ao core
- [ ] Tabelas próprias criadas no mesmo banco (sem conflito de nomes com tabelas do core)
- [ ] Transações gravadas em `transactions` para aparecer no histórico do portal
- [ ] Módulo respondendo na URL base configurada no admin

---

## 10. Fluxo completo de uma requisição

```
Cliente no portal
  → clica no módulo
  → portal faz fetch para /m/{slug}/...
  → core valida o JWT do cliente
  → core injeta os headers x-user-*
  → core encaminha a requisição para a URL base do módulo
  → módulo lê os headers e processa
  → resposta volta ao core
  → core retorna ao portal
```

O módulo **nunca vê o token JWT** diretamente — apenas os headers já decodificados.
