#!/usr/bin/env node

/**
 * Ping periódico numa URL. Ferramenta de diagnóstico, NÃO peça de produção.
 *
 * Leia isto antes de agendar o script em qualquer lugar: na configuração atual
 * ele não tem função. No Render, só o plano FREE hiberna por inatividade —
 * `render.yaml` declara `plan: starter` para a API e para o worker, e serviço
 * pago não dorme. Manter um ping de cinco em cinco minutos contra um serviço
 * que não hiberna não compra disponibilidade nenhuma: só gasta requisição,
 * suja o log e cria a impressão de que existe uma proteção onde não existe.
 *
 * Pior: o worker é `type: worker` e não expõe HTTP nenhum. Ele é quem envia as
 * mensagens, e nenhum keep-alive alcança ou ressuscita esse processo. Quem
 * detecta worker parado é o pulso — `VigiaWorkerService`, na API, lendo
 * `worker_pulso` de fora do processo do worker.
 *
 * Se o serviço um dia voltar ao plano Free, a resposta certa continua não
 * sendo este arquivo: é um monitor externo (UptimeRobot e afins) batendo em
 * `/api/saude`, que já existe, é `@Publico()` e confere o banco de passagem.
 *
 * O que sobra de uso legítimo aqui: conferir à mão, de um terminal, se a API
 * responde e com que latência.
 *
 * Uso:
 *   node scripts/keep-alive.mjs [URL] [INTERVALO_SEGUNDOS]
 *
 * Com INTERVALO_SEGUNDOS = 0 (padrão) faz UM pedido e sai com código 0 em
 * sucesso, 1 em falha — que é o que serve num terminal ou num CI. Qualquer
 * valor maior repete até receber Ctrl+C.
 *
 * Variáveis de ambiente (os argumentos têm precedência):
 *   DISPAROY_API_URL     - URL alvo (padrão: http://localhost:3000/api/saude)
 *   KEEP_ALIVE_INTERVAL  - Intervalo em segundos (padrão: 0 = uma vez só)
 *   KEEP_ALIVE_TIMEOUT   - Timeout de cada pedido em segundos (padrão: 10)
 */

const URL_ALVO = process.argv[2] || process.env.DISPAROY_API_URL || "http://localhost:3000/api/saude";
const INTERVALO_SEGUNDOS = inteiro(process.argv[3] ?? process.env.KEEP_ALIVE_INTERVAL, 0);
const TIMEOUT_MS = inteiro(process.env.KEEP_ALIVE_TIMEOUT, 10) * 1000;

/** Number() aceita "" e "abc" virando NaN/0 calados — aqui o padrão vale. */
function inteiro(bruto, padrao) {
  const n = Number.parseInt(String(bruto ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

/**
 * Um pedido. Devolve `true` só com resposta 2xx.
 *
 * `AbortSignal.timeout` em vez de um setTimeout à mão: sem teto, um servidor
 * que aceita a conexão e nunca responde deixa o processo pendurado para
 * sempre — que é justamente a falha que se está tentando detectar.
 */
async function pingar() {
  const inicio = Date.now();
  const instante = new Date().toISOString();

  try {
    const resposta = await fetch(URL_ALVO, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - inicio;

    if (resposta.ok) {
      console.log(`[${instante}] ok   GET ${URL_ALVO} -> ${resposta.status} (${ms} ms)`);
      return true;
    }
    console.error(`[${instante}] FALHA GET ${URL_ALVO} -> ${resposta.status} (${ms} ms)`);
    return false;
  } catch (erro) {
    const ms = Date.now() - inicio;
    // `AbortSignal.timeout` rejeita com TimeoutError; distinguir de rede fora
    // é o que diferencia "demorou" de "não existe".
    const causa = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
    console.error(`[${instante}] ERRO  GET ${URL_ALVO} -> ${causa} (${ms} ms)`);
    return false;
  }
}

const ok = await pingar();

if (INTERVALO_SEGUNDOS <= 0) {
  // Código de saída para quem chama de script: 0 respondeu, 1 não respondeu.
  process.exit(ok ? 0 : 1);
}

console.log(`Repetindo a cada ${INTERVALO_SEGUNDOS}s. Ctrl+C para parar.`);
setInterval(() => void pingar(), INTERVALO_SEGUNDOS * 1000);
