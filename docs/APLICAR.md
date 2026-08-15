# Como aplicar — atribuição de falha + caixa de avisos

Checklist da entrega de 14/08/2026. Siga na ordem: o código novo escreve em
colunas e chama funções que só existem depois das migrations.

## 1. Migrations, nesta ordem

No SQL Editor do Supabase, ou `supabase db push`:

```
supabase/migrations/20260814000100_status_pausada_por_canal.sql
supabase/migrations/20260814000200_atribuicao_falha.sql
supabase/migrations/20260814000300_caixa_avisos.sql
supabase/migrations/20260815000100_diagnostico_falhas.sql
supabase/migrations/20260815000200_empresas.sql
supabase/migrations/20260815000300_opt_out_por_empresa.sql
```

As duas últimas vão juntas: a `20260815000200` tira a unicidade global de
`contatos.telefone`, e é ela que faz `registrar_opt_out` — que casa por telefone
— passar a poder acertar mais de uma linha. Aplicar a primeira sem a segunda
deixa o pedido de saída marcando uma empresa ao acaso.

As três são idempotentes e rodam sobre o banco que já está no ar.

A primeira vai sozinha de propósito: em Postgres, valor de enum adicionado não
fica visível para função criada na mesma transação, e a segunda cria funções que
referenciam `pausada_por_canal`.

## 2. Testes, antes de subir

```bash
cd Disparoy-Backend && npm run typecheck && npm test
cd ../Disparoy        && npm run typecheck && npm test
```

Mexi em `backend/src/whatsapp/sequencia.test.ts` (o mock de falha agora precisa
de `codigo`). Não consegui rodar a suíte aqui: o `node_modules` foi instalado no
Windows e o binário nativo do rollup não roda no Linux do sandbox.

## 3. Deploy

Nada de variável de ambiente nova. Render (API + worker juntos) e Vercel.

**A ordem importa:** migrations primeiro, código depois. O contrário quebra todo
insert em `mensagens_enviadas`, que agora grava `erro_codigo` e `erro_categoria`.

---

## O que passa a acontecer

**Canal cai no meio da campanha.** O worker não marca mais os contatos como
`falhou`. Ele pergunta ao gateway (`instance/connectionState`) e:

| Gateway responde | O que acontece |
|---|---|
| `open` | A suspeita era falsa. O cache é corrigido, o contato falha sozinho, a campanha segue. |
| `close` / `connecting` | Canal vira `desconectado`, campanha vira `pausada_por_canal`, contatos voltam para `pendente`. |
| não responde | Canal **não** é rebaixado. Incidente `gateway_indisponivel` — o problema é nosso. |

**O webhook reage na hora.** `CONNECTION_UPDATE` com sessão fechada pausa
imediatamente todas as campanhas ativas daquele canal. O watchdog de um minuto
virou rede de segurança, não mecanismo principal.

**A campanha volta sozinha.** Quando o canal reconecta, `vigiarCanais()` fecha
os incidentes, chama `retomar_campanhas_do_canal` e reenfileira o planejamento.
Só solta o que o sistema pausou — campanha que uma pessoa pausou continua
pausada.

**Todo erro tem código e categoria.** `ResultadoEnvio.codigo` virou obrigatório;
o compilador recusa caminho de falha não classificado.

**A classificação é auditável pelo painel.** A query que antes precisava ser
escrita à mão no SQL Editor virou tela: **Diagnóstico** (menu, só admin) mostra
as falhas agrupadas por código na janela de 7, 30 ou 90 dias, quantos canais e
campanhas cada uma atingiu, e — o que importa de fato — o texto que o gateway
respondeu, agrupado por padrão.

É esse texto que fecha o ciclo. A Evolution não publica catálogo de erro e muda
as mensagens entre versões: quando uma regra de `classificarEvolution` para de
casar, as falhas escorrem para `desconhecido` sem que nada quebre visivelmente.
A linha **"Cobertura da taxonomia"** no topo da tela é o alarme disso — se ela
cai, tem regra a escrever, e o exemplo intacto ao lado é o material para
escrever o regex.

O equivalente em SQL, se precisar fora do painel:

```sql
select erro_categoria, erro_codigo, count(*)
from mensagens_enviadas
where erro_codigo is not null
group by 1, 2 order by 3 desc;
```

**Cada perfil tem caixa de avisos.** Incidente aberto vira notificação para
admins e para quem tem o canal vinculado (`canal_membros`). O selo de origem
nomeia a culpa: "Seu WhatsApp", "Nosso servidor", "Números de destino". Menu
**Avisos**, com contador no topo.

---

## Verificação em produção

1. Desconecte um canal pelo celular (WhatsApp > Aparelhos conectados > sair).
2. Em até 60 s: canal em `desconectado`, aviso na caixa com selo "Seu WhatsApp",
   campanhas ativas em "Pausada pelo sistema".
3. Reconecte pelo QR. Em até 60 s: aviso de resolução, campanhas retomadas.

Se o passo 2 não acontecer, o webhook provavelmente não está registrado — crie
um canal novo e veja se a resposta traz `aviso`. Isso antes falhava em silêncio.

---

## O que ficou de fora

**Entrega em tempo real.** A caixa atualiza por polling de 30 s. O documento
`CAIXA-DE-AVISOS.md` descreve o SSE, mas ele não muda o produto, só troca "em
até 30 s" por "em 2 s". Deixei de fora por não valer a complexidade agora.

**Alerta ativo.** Os avisos vivem no painel; ninguém é acordado às 3h. Próximo
passo natural seria mandar o incidente novo para um grupo de WhatsApp interno.

**As medidas anti-ban.** Depois que você contou que dispara 15 contatos às 10h,
quase toda a lista perdeu sentido — janela de horário, aquecimento derivado e
particionamento de lista foram calibrados para volume que não existe aqui. O que
sobreviveu é o isolamento de infraestrutura por cliente, e ele só vale a pena
depois de decidir entre Baileys e API Oficial.

**Isolamento entre empresas — em andamento (15/08/2026).**

A pergunta que bloqueava está respondida: **uma conta por empresa**
(`acesso@empresa.com`), mais uma conta global de administração, e cada empresa
gerando várias instâncias/QR codes.

Feito:

- `empresas` + `perfis.empresa_id`. `null` nesse campo é a conta global, que
  atravessa todas as empresas — é o acesso de suporte, não um dado faltando.
- `empresa_id` em `contatos`, `listas`, `templates`, `spintax`, `campanhas` e
  `canais`, com default apontando para a empresa padrão, que herdou tudo que já
  existia. **A migration não quebra nada aplicada sozinha:** enquanto a API não
  informa o dono, todo insert cai na empresa padrão e o sistema se comporta como
  hoje.
- As unicidades passaram a valer por empresa: `(empresa_id, telefone)`,
  `(empresa_id, nome, idioma)`, `(empresa_id, nome)`. É o coração da coisa — sem
  isso `empresa_id` seria decoração e o upsert seguiria assumindo a linha alheia.
- Trigger em `lista_contatos` recusando lista e contato de empresas diferentes.
- `noEscopo()` / `empresaParaEscrita()` em `comum/escopo.ts`, com testes. A API
  roda com service role e ignora RLS: esse filtro **é** a defesa, e existe em um
  lugar só para não virar seis cópias que divergem.
- **Contatos e listas totalmente isolados**, incluindo os três caminhos que
  vazavam: o upsert por telefone global, o `vincularALista` que pegava a linha
  do mesmo telefone de outra empresa, e o `listaId` vindo do cliente sem
  conferência de dono.

Falta, e **não quebra nada enquanto não for feito** (tudo cai na empresa padrão):

- Escopo em `templates`, `spintax`, `campanhas` e `canais` — mesma mecânica,
  `noEscopo` na leitura e `empresaParaEscrita` na escrita.
- Uma migration final trocando o default por `not null`, depois que toda escrita
  informar o dono. É ela que torna impossível esquecer.
- Tela de empresas e o vínculo do login à empresa na criação de usuário.
- Decidir o caminho do opt-out pelo webhook: hoje ele passa `p_empresa_id` nulo,
  que marca a saída em **todas** as empresas com aquele número. É a direção
  segura (marcar de menos é que viola), mas quando o webhook resolver o canal dá
  para restringir sem tocar na função.
