/**
 * Regras de negócio do DisparoY, sem dependência de framework.
 *
 * Consumido pela API (NestJS), pelo worker de disparo e pelo frontend — por
 * isso nada aqui pode importar Nest, React, Node-específico ou acessar rede.
 * É o que garante que a normalização de um telefone e o sorteio de um spintax
 * se comportem igual nos três lugares.
 */

export * from "./tipos.js";
export * from "./config.js";
export * from "./formato.js";
export * from "./phone.js";
export * from "./spintax.js";
export * from "./contatos.js";
export * from "./schemas.js";
export * from "./whatsapp/tipos.js";
