# Disponibilidade: o que se aplica ao Disparoy

Resumo: **no plano atual não existe hibernação, e não há keep-alive a
configurar.** Este documento existe para registrar por quê — a versão anterior
dizia o contrário e mandava agendar um ping de 5 em 5 minutos que não tinha
efeito nenhum.

## Por que não se aplica

No Render, só serviços do plano **Free** hibernam depois de ~15 minutos sem
requisição. O `render.yaml` deste repositório declara:

| Serviço          | `type`   | `plan`    | Hiberna? |
| ---------------- | -------- | --------- | -------- |
| `disparoy-api`   | `web`    | `starter` | Não      |
| `disparoy-worker`| `worker` | `starter` | Não      |

Plano pago não dorme. Um ping periódico contra esses serviços não compra
disponibilidade: gasta requisição, suja o log da API e — o pior — passa a
impressão de que existe uma proteção onde não existe.

Duas armadilhas que a versão anterior deste documento escondia:

- **O worker não tem HTTP.** É `type: worker`, sem porta aberta. Nenhum ping o
  alcança, e é justamente ele quem envia as mensagens. Um keep-alive na API
  responderia 200 com o worker morto há horas e nenhuma campanha saindo.
- **O frontend não precisa de nada.** É estático na Vercel, servido por CDN.

## O que de fato detecta indisponibilidade

Já existe e não depende de nada externo:

- **Worker parado** — o worker carimba `worker_pulso` a cada rodada de
  manutenção (de minuto em minuto). Quem confere é `VigiaWorkerService`, na
  **API**, de fora do processo do worker: um processo que travou não tem como
  avisar que travou. Passando de 3 minutos sem pulso, abre incidente, que
  aparece na caixa de avisos do painel.
- **Banco fora do ar** — `GET /api/saude` consulta o Postgres de passagem. É o
  `healthCheckPath` do Render.
- **Erro não tratado na API e crash do worker** — `ALERTA_WEBHOOK_URL`, quando
  preenchida, recebe um POST (Slack/Discord/Teams aceitam o formato). Sem ela,
  os dois só escrevem no log do Render.

## Se um dia o plano voltar a Free

A resposta ainda não é o script deste repositório. Use um monitor externo
(UptimeRobot e similares) apontando para `/api/saude` — a rota é `@Publico()`,
já confere o banco, e o monitor ainda avisa quando cai, que é o que um ping
mudo não faz. E aceite que o **worker** continuaria hibernando de qualquer
forma: no plano Free não existe `type: worker`, então o disparo simplesmente
não funcionaria.

## O script

`backend/scripts/keep-alive.mjs` continua no repositório como **ferramenta de
diagnóstico manual**, não como peça de produção:

```bash
# Um pedido; sai 0 se respondeu, 1 se não. Serve em terminal e em CI.
node backend/scripts/keep-alive.mjs https://disparoy-api.onrender.com/api/saude

# Repetindo a cada 60 s, até Ctrl+C.
node backend/scripts/keep-alive.mjs http://localhost:3000/api/saude 60
```

Variáveis de ambiente (os argumentos têm precedência): `DISPAROY_API_URL`,
`KEEP_ALIVE_INTERVAL`, `KEEP_ALIVE_TIMEOUT`.

O workflow `.github/workflows/keep-alive.yml` roda o mesmo script, mas só por
`workflow_dispatch` (botão "Run workflow") — o `schedule` foi removido pelo
motivo explicado acima.
