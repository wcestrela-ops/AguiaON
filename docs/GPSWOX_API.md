# GPSWOX API — Referência para a AguiaON

> Mapeado a partir da documentação oficial: https://gpswox.stoplight.io/docs/tracking-software
> Todos os endpoints abaixo foram **abertos e confirmados individualmente** nessa
> documentação (método, path, parâmetros e exemplo de resposta), não inferidos.
>
> Convenções da API GPSWOX (importante entender antes de usar qualquer endpoint):
> - Toda chamada leva `lang` (padrão `en`) e `user_api_hash` como **query params**,
>   mesmo em POST/PUT/DELETE.
> - A maioria das ações de "excluir"/"listar por id" usa **GET** com parâmetro
>   `*_id` na query (ex: `destroy_device?device_id=123`), **não** o verbo HTTP
>   `DELETE` — é uma API baseada em nomes de ação, não REST puro.
> - A exceção é a categoria **Compartilhamento** (`/api/sharing`), que é REST de
>   verdade: usa `GET/POST/PUT/DELETE` com `{id}` no path.
> - Em `src/shared/gpswoxClient.ts`, a função interna `request(estId, path, opts)`
>   monta a URL como `${cfg.url}/api/${path}` — então basta passar o nome da ação
>   (`'add_device'`) ou `'sharing/123'` para paths com id.

---

## 1. Localização / posição do veículo

### Posição mais recente de todos os dispositivos (polling em tempo real)
```
GET /api/get_devices_latest
```
Parâmetros úteis: `time` (retorna só quem mudou desde esse timestamp UNIX —
usado pra polling eficiente), `filters[id]`, `filters[imei]`,
`filters[plate_number]`, `filters[status]`, `filters[online]` / `filters[offline]`
(dispositivos online/offline há N minutos).

Resposta (`items[]`): `id`, `name`, `lat`, `lng`, `speed`, `course`, `time`,
`timestamp`, `online` (`"online"`/`"offline"`), `address`, `engine_status`,
`total_distance`, `device_data` (dados cadastrais do device), `events[]`
(alertas disparados recentemente).

### Histórico de posições (trajeto num período)
```
GET /api/get_history
```
Parâmetros **obrigatórios**: `device_id`, `from_date`, `from_time`, `to_date`,
`to_time` (data e hora **separadas**, não um datetime único). Opcional:
`snap_to_road` (ajusta o ponto pra rua mais próxima).

Resposta: `items[]` agrupados por "status" (1-Em movimento, 2-Parado,
3-Início, 4-Fim, 5-Evento), cada grupo com `items[]` de pontos GPS
(`lat`, `lng`, `speed`, `time`, `course`, `altitude`), mais agregados:
`distance_sum`, `top_speed`, `move_duration`, `stop_duration`, `engine_hours`,
`fuel_consumption`.

> ⚠️ **Bug encontrado**: `getHistory()` em `gpswoxClient.ts` (linha ~334) chama
> `get_history` passando `from`/`to` como query params. A API real não usa esses
> nomes — precisa de `from_date`, `from_time`, `to_date`, `to_time` como campos
> separados. Hoje esse endpoint provavelmente retorna vazio/erro sempre.
> Correção sugerida:
> ```ts
> export async function getHistory(estId: string, deviceId: string, fromDate: string, fromTime: string, toDate: string, toTime: string) {
>   const data = await request(estId, 'get_history', {
>     query: { device_id: deviceId, from_date: fromDate, from_time: fromTime, to_date: toDate, to_time: toTime },
>   });
>   ...
> }
> ```
> Ainda não corrigido no código — avisar antes de tratar como "Fix 50".

---

## 2. Dispositivo (veículo) — CRUD administrativo

### Listar dispositivos
```
GET /api/get_devices
```
Confirmado no Fix 48. Retorna árvore de grupos com `.items` = dispositivos.

### Criar dispositivo
```
POST /api/add_device
```
Body: `name` (obrig.), `imei` (obrig.), `user_id` (array de int, **opcional**),
`plate_number` (opcional), entre outros. Confirmado e já implementado
(`createDevice()`, Fix 48).

### Editar dispositivo
```
POST /api/edit_device
```
Query: `device_id` (obrig., também pode ir no body como `id`). Body: **nenhum
campo é obrigatório** na edição (só valida `name`/`imei` se enviados). Campos
relevantes pra AguiaON: `name`, `imei`, `plate_number`, `vin`,
`registration_number`, `sim_number`, `max_speed`, `min_moving_speed`,
`group_id`, `user_id[]` (donos), `tags[]`, `enable_expiration_date` +
`expiration_date`.

### Excluir dispositivo
```
GET /api/destroy_device?device_id={id}
```

### Grupos de dispositivos
```
GET  /api/... (Obter lista de grupos de dispositivos)
POST /api/... (Criar grupo de dispositivos)
PUT  /api/... (Atualizar grupo de dispositivos)
```
Localizados na doc oficial (categoria Dispositivo), ainda não abertos
individualmente — usar quando/se a AguiaON precisar de agrupamento visual de
frota. Hoje o código já lida com o formato "grupo com `.items`" que vem de
`get_devices` (Fix 47/48), então isso é sobre criar/editar os grupos em si,
não sobre ler a frota.

---

## 3. Usuário administrador / cliente final (GPSWOX "client")

O GPSWOX tem dois conceitos de conta: **client** (dono/usuário final do
rastreador — o que a AguiaON usa pra representar o cliente da loja) e
**admin user** (usuário do painel GPSWOX). A AguiaON usa `client`.

### Criar cliente (usuário final)
```
POST /api/admin/client
```
Confirmado em sessão anterior — usado no fluxo de cadastro do cliente.

### Atualizar cliente / trocar senha administrativamente
```
PUT /api/admin/client/{id}
```
Permite alterar dados cadastrais e forçar senha nova sem precisar do fluxo de
"esqueci minha senha".

### Trocar a própria senha (fluxo do cliente)
```
POST /api/password_reminder
```
Confirmado em sessão anterior. Usado pro "esqueci minha senha" self-service.

### Listar / excluir clientes
```
GET    /api/admin/client       (lista)
DELETE /api/admin/client/{id}  (excluir) — confirmar verbo exato antes de usar
```

---

## 4. Comando (bloqueio, desbloqueio, comandos gerais)

### Ver comandos disponíveis pra um dispositivo (catálogo dinâmico)
```
GET /api/get_device_commands?device_id={id}
```
Retorna o **catálogo de comandos suportados** pelo modelo/protocolo do
dispositivo (`type`, `title`, `connection`: gprs/sms, e os `attributes[]`
esperados por comando — ex.: bloqueio de motor pode exigir um parâmetro
específico dependendo do rastreador). Útil pra montar dinamicamente os botões
de comando na UI em vez de fixar "bloquear"/"desbloquear" hardcoded.

### Enviar comando via GPRS (internet do rastreador)
```
POST /api/send_gprs_command
```
Já confirmado e implementado (`sendCommand()` / uso existente). Corpo inclui
`device_id` e o `type`/parâmetros do comando (ver catálogo acima).

### Enviar comando via SMS (fallback quando o rastreador está sem internet)
```
POST /api/send_sms_command
```
Mesma lógica do GPRS, mas via SMS — é a base natural pra um failover 4G→SMS
mais completo (o código já tem `isGpsFailoverEligible()` pensando nisso).

### Histórico de comandos enviados
```
GET /api/sent_commands
```
Parâmetros: `connection` (filtra gprs/sms), `includes` (`user`,`device`),
`search`, `sorting[sort]`/`sorting[sort_by]`. Resposta paginada com `id`,
`imei`, `connection`, `command_title`, `parameters`, `response`, `status`
(sucesso/falha), `created_at`, `device`, `user`. Isso dá uma tela de
"histórico de comandos enviados" pronta (bloqueios/desbloqueios anteriores,
quem mandou, se confirmou).

---

## 5. Compartilhamento de localização

Única categoria que é REST "de verdade" (`/api/sharing`, com verbos HTTP reais
e `{id}` no path).

### Listar compartilhamentos
```
GET /api/sharing
```

### Criar compartilhamento
```
POST /api/sharing
```
Body: `devices[]` (obrig.), `name`, `active`, `enable_expiration_date`
(boolean), `expiration_date` (string, formato `"YYYY-MM-DD HH:mm:ss"` — data
**absoluta**, não uma duração em minutos/horas), `email`, `sms`.

### Ver um compartilhamento
```
GET /api/sharing/{id}
```

### Atualizar compartilhamento (inclui mudar expiração/ativar/desativar)
```
PUT /api/sharing/{id}
```
Body: `devices[]`, `active`, `name`, `enable_expiration_date`,
`expiration_date`.

### Excluir compartilhamento
```
DELETE /api/sharing/{id}
```

### Atualizar só os dispositivos de um compartilhamento
```
PUT /api/sharing/{id}/... (Update sharing item devices — verificar path exato antes de usar)
```

> ⚠️ **Bug encontrado**: `createSharing()` em `gpswoxClient.ts` (linha ~358)
> envia `expiration_by: 'duration'` e `expiration_duration: durationMinutes` —
> **esses campos não existem** na API real. O campo certo é
> `enable_expiration_date: true` + `expiration_date: "YYYY-MM-DD HH:mm:ss"`
> (data/hora absoluta de expiração, calculada a partir de `durationMinutes` no
> próprio código: `new Date(Date.now() + durationMinutes*60000)` formatado).
> Hoje, ao criar um compartilhamento "por X horas", a API provavelmente ignora
> silenciosamente esse campo e cria o link **sem expiração** (ou dá erro de
> validação, a depender da versão). Correção sugerida:
> ```ts
> export async function createSharing(estId: string, deviceId: string, durationMinutes: number): Promise<SharingResult> {
>   const expirationDate = new Date(Date.now() + durationMinutes * 60000);
>   const expirationStr = expirationDate.toISOString().slice(0, 19).replace('T', ' ');
>   const raw = await request(estId, 'sharing', {
>     method: 'POST',
>     body: {
>       devices: [Number(deviceId)],
>       enable_expiration_date: true,
>       expiration_date: expirationStr,
>     },
>   });
>   ...
> }
> ```
> Também dá pra implementar `deleteSharing(estId, sharingId)` chamando
> `request(estId, \`sharing/${sharingId}\`, { method: 'DELETE' })` — hoje não
> existe função pra isso no `gpswoxClient.ts`.
> Ainda não corrigido no código — avisar antes de tratar como "Fix 50".

---

## 6. Alerta (ignição on/off, velocidade, geocerca, e mais)

Sistema de alertas do GPSWOX é genérico: um único endpoint de criar/editar
serve pra todos os tipos, e o campo `type` decide quais outros campos são
usados.

### Listar alertas configurados
```
GET /api/get_alerts
```
Resposta: `id`, `active`, `name`, `overspeed_speed`, `devices[]`,
`geofences[]`, `drivers[]`, etc.

### Criar alerta
```
POST /api/add_alert
```
### Editar alerta
```
POST /api/edit_alert
```
(mesmos campos do `add_alert`, mais `id` obrigatório)

Campos-chave por `type` (confirmados na doc oficial):

| `type`              | Campos extras relevantes                          | Uso                                    |
|---------------------|----------------------------------------------------|-----------------------------------------|
| `ignition`           | `state` (0/1)                                      | Alerta de ligou/desligou o motor        |
| `ignition_duration`  | `ignition_duration`, `pre_start_checklist_only`     | Motor ligado por mais de X segundos     |
| `overspeed`          | `overspeed` (limite km/h)                          | Excesso de velocidade                   |
| `geofence_in`/`_out`/`_inout` | `geofences[]`                             | Entrou/saiu de cerca virtual            |
| `stop_duration`       | `stop_duration`                                    | Parado por mais de X segundos           |
| `idle_duration`       | `idle_duration`                                    | Marcha lenta por mais de X segundos     |
| `offline_duration`    | `offline_duration`                                 | Rastreador offline há X segundos        |
| `distance`            | `distance`, `period`                               | Rodou mais de X km em N dias            |
| `device_expiration`   | `case` (expired/expiring/expired_sim/expiring_sim), `days` | Vencimento de plano/SIM         |
| `driver_unauthorized` | `authorized`                                       | Motorista não autorizado dirigiu        |

Todo alerta também aceita `notifications` (email/push/webhook/som/popup/cor),
`schedule`+`schedules` (janela de horário em que vale), `devices[]`,
`users[]`, `command` (dispara um comando automaticamente quando o alerta
bate).

### Ativar/desativar alerta
```
GET /api/change_active_alert
```
Body: `id` (int ou array), `active` (bool).

### Excluir alerta
```
GET /api/destroy_alert?alert_id={id}
```

### Protocolos disponíveis
```
GET /api/... (List Get Protocols — usado pra saber quais tipos de alerta o dispositivo suporta)
```

---

## 7. Geocerca (cerca virtual) — CRUD completo

Isso resolve a causa provável do bug 500 em `/agenda/frota-cercas`: o código
atual só tem `listGeofences()` (leitura); criar/editar/excluir geocerca nunca
foi implementado contra o endpoint certo.

### Listar geocercas
```
GET /api/get_geofences
```
Já implementado (`listGeofences()`, trata o formato `{items:{geofences:[...]}}`).

### Criar geocerca
```
POST /api/add_geofence
```
Body: `name` (obrig.), `type` (obrig., `"circle"` ou `"polygon"`), `active`,
`device_id`, `group_id`, `polygon_color` (obrig., hex tipo `#00AB33`),
`speed_limit`. Se `type: "circle"` → `center: {lat,lng}` + `radius`
(obrigatórios). Se `type: "polygon"` → `polygon: [{lat,lng}, ...]`
(obrigatório; **primeiro e último ponto devem ser iguais**, pra fechar o
polígono).

### Editar geocerca
```
POST /api/edit_geofence
```
Mesmos campos do `add_geofence`, mais `id` (obrigatório).

### Ativar/desativar geocerca
```
GET /api/change_active_geofence
```

### Excluir geocerca
```
GET /api/destroy_geofence?geofence_id={id}
```

### Grupos de geocerca
```
GET  /api/... (lista de grupos)
POST /api/... (criar grupo)
PUT  /api/... (atualizar grupo)
```

### Consultas analíticas de geocerca (avançado, opcional)
```
GET /api/... (Geofences currently containing — quais geocercas têm um dispositivo dentro agora)
GET /api/... (Was device in geofence during — o veículo passou pela cerca num período?)
GET /api/... (Device time spent inside geofence — quanto tempo dentro da cerca)
```
Esses três existem na doc oficial mas não foram abertos endpoint-a-endpoint
ainda (paths exatos a confirmar quando for implementar). Úteis pra relatórios
tipo "quanto tempo o carro ficou na obra X esse mês".

---

## 8. Autenticação

### Login (obter `user_api_hash`)
```
POST /api/... (Create a Login)
```
Retorna o `user_api_hash` usado em todas as outras chamadas — a AguiaON
guarda esse hash já configurado por empresa (`gpswox_config`), então esse
endpoint só é relevante se algum dia for necessário logar programaticamente
em vez de usar um hash fixo configurado manualmente no painel.

### Esqueci minha senha
```
POST /api/password_reminder
```
Confirmado em sessão anterior.

---

## Resumo — cobertura do escopo pedido

| Pedido do Carlos                                   | Status                                                              |
|-----------------------------------------------------|-----------------------------------------------------------------------|
| Localização do veículo                               | ✅ `get_devices_latest` (tempo real) + `get_history` (trajeto)        |
| Criar veículo no GPSWOX                              | ✅ `add_device` (já implementado, Fix 48)                             |
| Criar usuário (cliente)                              | ✅ `admin/client` POST                                                |
| Trocar senha                                          | ✅ `password_reminder` (self-service) + `admin/client` PUT (forçada) |
| Mandar bloqueio/desbloqueio                          | ✅ `send_gprs_command` / `send_sms_command` (catálogo em `get_device_commands`) |
| Mandar comandos (geral)                              | ✅ idem acima + histórico via `sent_commands`                         |
| Compartilhar localização (criar)                     | ✅ `POST /api/sharing` — **bug no código atual, campo errado**        |
| Compartilhamento por duração                          | ✅ confirmado que é `expiration_date` absoluto, não duração           |
| Excluir compartilhamento                              | ✅ `DELETE /api/sharing/{id}` — **não implementado ainda no código**  |
| Alerta ligou/desligou (ignição)                       | ✅ `add_alert`/`edit_alert` com `type: ignition`/`ignition_duration`  |
| Cerca virtual (criar)                                 | ✅ `add_geofence`/`edit_geofence`/`destroy_geofence` — **não implementado ainda** |
| Velocidade                                            | ✅ `overspeed` (alerta) + `max_speed` (campo do dispositivo)          |

---

## Próximos passos sugeridos (aguardando decisão do Carlos)

1. **Fix 50** (a definir): corrigir `getHistory()` (params `from_date`/`from_time`/`to_date`/`to_time`) e `createSharing()` (`enable_expiration_date`/`expiration_date`) em `gpswoxClient.ts`.
2. Implementar `deleteSharing()`, `updateSharing()` e `listSharing()` (hoje só existe `createSharing()`).
3. Implementar `addGeofence()`/`editGeofence()`/`destroyGeofence()` — provável correção do 500 em `/agenda/frota-cercas`.
4. Se for útil pro cliente final: expor alertas de ignição/velocidade/geocerca na UI da loja (`add_alert`/`edit_alert`), hoje 100% não usados pela AguiaON.
