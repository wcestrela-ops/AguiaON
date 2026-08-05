# Ideia em aberto — GPSWOX self-hosted + leitura direta do banco

> Status: só uma ideia, discutida em conversa — **nada foi implementado, nenhum código foi alterado**. Este arquivo existe só pra retomar o assunto numa conversa nova sem perder o contexto.

## O problema de partida

Hoje o módulo Rastreamento (`src/shared/gpswoxClient.ts` e uso em `src/routes/agenda/index.ts`) fala com o GPSWOX via API REST a cada consulta — listar dispositivos, pegar posição, histórico, comandos (bloquear/desbloquear motor), cercas. Cada tela do painel que mostra dado de rastreamento faz uma chamada de rede síncrona pro servidor do GPSWOX, o que deixa a experiência mais lenta do que se os dados já estivessem localmente.

## A ideia do Carlos

1. O GPSWOX usado pela AguiaON já é **self-hosted na própria VPS do Carlos** — ele tem acesso total ao servidor.
2. Como ele mesmo controla a instância, ela **só é atualizada se ele quiser** — isso muda o cálculo de risco de ler direto do banco de dados interno do GPSWOX (schema não documentado publicamente, mas que só muda quando ele decidir atualizar).
3. Ideia: em vez de bater na API do GPSWOX a cada requisição, ler **direto do banco de dados** dessa instância self-hosted — deixando as consultas do painel rápidas, sem depender de round-trip de rede/API pra cada tela.
4. Extensão da ideia: já que a AguiaON teria essa estrutura de rastreamento própria e controlada, ela poderia também **disponibilizar essa infraestrutura pra outras empresas** (não só consumir internamente pro próprio módulo Rastreamento) — um possível novo modelo de negócio (virar fornecedor de infraestrutura de rastreamento, não só cliente do GPSWOX).

## Pontos levantados na conversa (a favor e contra)

**A favor:**
- Self-hospedar já elimina a maior parte da lentidão (sem depender da rede/servidor externo do GPSWOX).
- Controlar quando atualiza reduz bastante o risco de "schema muda sem aviso" que existiria com uma instância hospedada pelo próprio GPSWOX.

**Pontos de atenção, mesmo com controle total:**
- Ficar preso à versão atual: se um dia precisar atualizar (suporte a chip de rastreador novo, correção de segurança), qualquer código que leia direto do banco interno vai precisar ser revalidado, já que ninguém garante que o schema não mudou entre versões.
- Sem atualizar, patches de segurança da própria aplicação GPSWOX ficam por conta da AguiaON — ninguém empurra isso automaticamente.
- Comandos "ao vivo" (bloquear/desbloquear motor, etc.) continuariam precisando passar pela API (ou pelo protocolo do rastreador), não dá pra fazer só lendo o banco.

**Sobre "disponibilizar a estrutura" pra terceiros (pergunta em aberto, ainda não respondida pelo Carlos):**
- Precisa checar se a licença do GPSWOX que ele tem permite sublicenciar/revender acesso pra terceiros — muitas licenças white-label restringem isso ou exigem um tier de "revenda" separado.
- Se for oferecer pra fora, a régua de responsabilidade sobe bastante: passa a ser rastreamento de veículo de cliente de outra empresa rodando na infra da AguiaON, o que pede um nível de suporte/uptime bem mais sério do que um cache/uso só interno.

## Alternativa mais conservadora, mencionada na conversa

Em vez de ler direto do banco interno do GPSWOX, manter a API oficial (self-hospedada ou não) só pra:
- Escrever comandos (bloquear motor, etc.), e
- Alimentar um **cache próprio** — um job que puxa posição/status periodicamente (ou via webhook, se o GPSWOX suportar) e guarda isso na tabela própria da AguiaON (`agenda_frota`, que já existe).

Assim toda tela do painel lê do banco da própria AguiaON — rápido, sem depender da rede/API do GPSWOX na hora que o lojista abre a tela — sem ficar acoplado ao schema interno de terceiro. É o padrão que dashboards de rastreamento sérios costumam usar.

## Próximo passo (quando o Carlos quiser retomar)

Decidir entre:
1. Ler direto do banco do GPSWOX self-hosted (mais rápido de implementar, mais acoplado/frágil a longo prazo).
2. Cache próprio alimentado pela API do GPSWOX (um pouco mais de trabalho, mais resiliente a mudanças de versão do GPSWOX).
3. Esclarecer se "disponibilizar a estrutura pra terceiros" é uma linha de negócio real a explorar (e, se for, checar a licença do GPSWOX antes de qualquer coisa).
