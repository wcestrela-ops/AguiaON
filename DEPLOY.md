# Deploy no EasyPanel

Passo a passo pra colocar o AguiaON no ar num servidor com EasyPanel instalado.
Repositório: `wcestrela-ops/AguiaON` (branch `master`).

## 1. Banco de dados (Postgres)

1. No projeto do EasyPanel, **New Service → Postgres**.
2. Dê um nome (ex: `postgres`) e crie. Pode deixar nome do banco/usuário/senha
   no automático — o EasyPanel gera.
3. Espere o serviço subir e abra a aba **Credentials** — copie a **internal
   connection URL** (algo como `postgres://postgres:SENHA@aguiaon_postgres:5432/aguiaon`).
   **Adicione `?sslmode=disable` no final dela** — o Postgres interno do
   EasyPanel não fala SSL, e sem esse parâmetro a conexão falha (bug real que
   corrigimos em `src/shared/db.ts` durante essa fase: a detecção antiga só
   desligava SSL se o host fosse literalmente `localhost`).
4. **Aplique o schema completo antes de subir o App** — banco vazio quebra
   praticamente toda rota (`relation "establishments" does not exist`, etc.).
   Abra o **Shell** do serviço Postgres (botão que abre um `psql` já
   autenticado como `postgres`) e cole o conteúdo inteiro de
   **`database/deploy_bootstrap.sql`** de uma vez só — é o `schema.sql` +
   todas as migrations (`v2` até `v20`) já concatenadas em ordem, geradas
   nesta mesma fase pra evitar colar ~20 arquivos um por um. Todo comando ali
   é `IF NOT EXISTS`, então rodar de novo (ex: depois de um `git pull` com
   migration nova) não apaga nada — só aplica o que ainda não existia.
   Se preferir aplicar os arquivos originais um a um (ex: pra revisar cada
   um), eles continuam em `database/migration_v*.sql`, na mesma ordem
   numérica; boa parte das tabelas mais novas (SMS, GPSWOX, billing) também
   se cria sozinha na primeira vez que a rota correspondente é usada
   (`ensureTables()`), mas as tabelas core (`establishments`, `users`,
   `delivery_orders`, `otp_codes`, `global_settings`, `rate_limit_store`...)
   não — essas só existem se você rodar o SQL.

## 2. App (a API do AguiaON)

1. **New Service → App**, dê um nome (ex: `api`).
2. Aba **Source** → **GitHub** → `wcestrela-ops/AguiaON`, branch `master`,
   Build Path `/`.
   - Repositório público, então não precisa configurar token do GitHub.
3. Aba **Build** → selecione **Dockerfile** (o repositório já tem um na raiz,
   `/Dockerfile`, com multi-stage build + healthcheck).
4. Aba **Environment** — cole (ajustando os valores):

   ```
   NODE_ENV=production
   PORT=3000
   DATABASE_URL=postgres://postgres:SENHA@aguiaon_postgres:5432/aguiaon?sslmode=disable
   JWT_SECRET=gere_com_openssl_rand_-hex_64
   ENCRYPTION_KEY=gere_com_openssl_rand_-hex_32
   ADMIN_SECRET_KEY=outra_string_aleatoria
   ADMIN_WHATSAPP=5511999999000
   ADMIN_EMAIL=admin@seudominio.com
   PLATFORM_BASE_DOMAIN=seudominio.com
   ```

   Gere segredos com `openssl rand -hex 64` (JWT_SECRET) e `openssl rand -hex 32`
   (ENCRYPTION_KEY). Se for usar Mercado Pago (OAuth por empresa) ou billing da
   plataforma (Fase 5), adicione também `MP_CLIENT_ID`, `MP_CLIENT_SECRET`,
   `MP_REDIRECT_URI`, `PLATFORM_ASAAS_API_KEY`, `PLATFORM_PIX_KEY_VALUE` — ver
   `.env.example` para a lista completa comentada.

5. Aba **Domains** → adicione o domínio (ex: `ag-on.com` e, se quiser
   white-label, o wildcard `*.ag-on.com` — ver observação abaixo). **Target
   Port: `3000`** (é a porta que o `server.ts` escuta) — **precisa ser
   exatamente igual ao valor de `PORT` que você colocou na aba Environment**.
   Se mudar um sem mudar o outro, o app sobe normal (aparece nos logs
   `[worker N] rodando na porta X`), mas o healthcheck e o proxy do EasyPanel
   continuam batendo na porta errada, e o deploy fica travado em "amarelo"
   pra sempre mesmo com o servidor de pé — foi exatamente esse mismatch (Target
   Port/healthcheck em 3000, `PORT` do ambiente setado pra 80) que causou esse
   sintoma numa subida real; o `Dockerfile` foi corrigido pra o `HEALTHCHECK`
   ler a porta de `$PORT` dinamicamente em vez de fixa em 3000, mas o **Target
   Port** do EasyPanel continua sendo configuração manual sua — confira que
   bate com o `PORT` do Environment antes de reportar deploy travado.
6. Volte no **Overview** e clique **Deploy**. Acompanhe o build nos logs —
   deve terminar em `[worker N] rodando na porta 3000` (ou na porta que você
   configurou em `PORT`, desde que o Target Port da aba Domains seja a mesma).
7. Ative **Auto Deploy** (no Overview) pra todo push na `master` disparar
   redeploy automático via webhook do GitHub.

## 3. Conferir que subiu certo

- `https://seudominio.com/health/live` → `{"status":"ok"}` (processo de pé).
- `https://seudominio.com/health/ready` → `{"status":"ready"}` (banco
  respondendo). Se vier 503, confira a `DATABASE_URL` (item 1.3) — é o erro
  mais comum de primeira subida.
- O Dockerfile já tem `HEALTHCHECK` embutido, então o próprio Docker também
  vai reportar o container como unhealthy se `/health/live` parar de
  responder — útil pra restart automático dependendo de como o EasyPanel/servidor
  estiver configurado.

## 4. White-label (Fase 4) — opcional

Se quiser que cada empresa tenha subdomínio próprio (`loja1.ag-on.com`), o
domínio no EasyPanel precisa ser wildcard (`*.ag-on.com`) apontando pro mesmo
App service, com um registro DNS `*` (CNAME ou A) pro IP do servidor.

Domínio 100% customizado por empresa (ex: `www.lojadocliente.com.br`) segue o
mesmo princípio do lado do DNS (o cliente aponta o domínio dele pro seu
servidor), e o lojista cadastra o próprio domínio via
`PUT /lojista/setup/settings` com `{ "custom_domain": "www.lojadocliente.com.br" }`
(rota corrigida nesta mesma leva — o campo existia no banco desde a Fase 4,
mas não tinha endpoint pra escrever nele até agora). Emitir o certificado TLS
pra cada domínio customizado é infraestrutura fora do que o EasyPanel resolve
sozinho automaticamente — ver `AguiaON-ROADMAP.md`, Fase 4.

## 5. Alternativa: imagem do GHCR em vez de build no EasyPanel

O repositório já publica a imagem automaticamente no GitHub Container Registry
a cada push na `master` (`.github/workflows/ci.yml`, Fase 6). Se preferir não
buildar direto no EasyPanel:

1. Torne o pacote público em `github.com/wcestrela-ops/AguiaON/pkgs/container/aguiaon`
   (Package settings → Change visibility), ou gere um token com permissão
   `read:packages` pra usar como credencial privada.
2. No App service, Source → **Docker Image** → `ghcr.io/wcestrela-ops/aguiaon:latest`
   (ou fixe uma tag de commit específica em vez de `latest`, mais reprodutível).
3. Sem builder pra configurar — a imagem já vem pronta. O resto (env vars,
   domínio, porta) é igual ao passo 2 acima.

Essa via é mais rápida pra redeployar (não builda de novo no servidor), mas
exige lembrar de trocar a tag manualmente se não usar `latest`.
