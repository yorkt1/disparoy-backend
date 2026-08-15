import type { NextFunction, Request, Response } from "express";

/**
 * Cabeçalhos de segurança da API.
 *
 * Escrito à mão em vez de `helmet` porque esta API serve JSON e mais nada: dos
 * quinze middlewares do helmet, os quatro que importam aqui cabem em vinte
 * linhas. Uma dependência a menos é uma dependência a menos para auditar,
 * atualizar e para quebrar o deploy num domingo.
 *
 * O painel é servido pela Vercel e tem os cabeçalhos dele em `vercel.json` —
 * inclusive a CSP, que só faz sentido onde existe HTML.
 */
export function cabecalhosDeSeguranca(_req: Request, res: Response, next: NextFunction): void {
  // Diz que o servidor é Express, e a versão. Informação de graça para quem
  // procura alvo com CVE conhecida.
  res.removeHeader("X-Powered-By");

  /**
   * O navegador não pode adivinhar o tipo do conteúdo.
   *
   * Sem isto, uma resposta JSON com corpo controlado pelo usuário — o nome de
   * um contato importado da planilha, por exemplo — pode ser interpretada como
   * HTML e executar script na origem da API.
   */
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Uma API não tem por que existir dentro de um iframe.
  res.setHeader("X-Frame-Options", "DENY");

  /**
   * Nenhum Referer para fora.
   *
   * As URLs desta API carregam id de campanha e de contato no caminho; mandá-las
   * no Referer entregaria isso a qualquer domínio de terceiro.
   */
  res.setHeader("Referrer-Policy", "no-referrer");

  // Nada de HTML aqui: a CSP mais restritiva possível é a correta.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");

  /**
   * HSTS só em produção.
   *
   * Em desenvolvimento o painel roda em http://localhost, e o navegador guarda
   * a diretiva por HOST: um HSTS emitido por engano em localhost trava todo
   * projeto que use essa porta na máquina, e limpar isso exige mexer em
   * configuração interna do navegador.
   */
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}
