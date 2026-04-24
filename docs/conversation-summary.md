# Conversation Summary

Data: 2026-04-24

Este arquivo registra a conversa de forma sanitizada. Senhas, tokens, segredos de webhook e chaves de API foram omitidos de proposito.

## Objetivo inicial

Instalar o Evo CRM Community no Portainer em `chat.senhorcolchao.com`, com stack chamada inicialmente `Chat_Crm`.

## EvoCRM

- Portainer usado: `portainer.senhorcolchao.com`
- Stack criada no Portainer: `chat_crm`
- Dominio publico: `https://chat.senhorcolchao.com`
- Imagens trocadas para oficiais da comunidade:
  - `evoapicloud/evo-crm-gateway:latest`
  - `evoapicloud/evo-auth-service-community:latest`
  - `evoapicloud/evo-ai-crm-community:latest`
  - `evoapicloud/evo-ai-core-service-community:latest`
  - `evoapicloud/evo-ai-processor-community:latest`
  - `evoapicloud/evo-bot-runtime:latest`
  - `evoapicloud/evo-ai-frontend-community:latest`

Validacoes feitas:

- Frontend `https://chat.senhorcolchao.com`: HTTP 200
- EvoCRM `/health`: HTTP 200
- Todos os servicos principais: `running`

## Integracao FZAP/Wuzapi

Foi decidido nao modificar o codigo oficial do EvoCRM para manter atualizacoes simples via Portainer. A integracao foi feita como stack separada.

- Stack criada: `fzap_evo_bridge`
- Bridge publica: `https://chat.senhorcolchao.com/fzap/health`
- Wuzapi/FZAP: `https://wuzapi.senhorcolchao.com`
- Inbox EvoCRM criado: `FZAP WhatsApp`
- Token de API dedicado criado no EvoCRM para a bridge
- Webhooks adicionados na Wuzapi sem remover webhooks antigos

Fluxo implantado:

```text
Wuzapi/FZAP -> fzap_evo_bridge -> EvoCRM
EvoCRM -> fzap_evo_bridge -> Wuzapi/FZAP -> WhatsApp
```

## Canais

- Canal 1: `551733245765`
- Canal 2: `551733233694`

Ambos entram no mesmo inbox `FZAP WhatsApp`, com identificacao em atributos da conversa/contato.

## Comportamento esperado

- Conversa completa de texto bidirecional
- Respostas do EvoCRM enviadas pelo WhatsApp via FZAP
- Atendimento humano no EvoCRM
- Pipeline e atribuicoes do CRM
- Respostas rapidas dentro do fluxo do inbox
- Agentes de IA do EvoCRM quando configurados no inbox/conversa

## Observacoes

- Midia/audio/documentos ainda precisam ser refinados com payload real da Wuzapi. A bridge atual usa fallback de link/descricao quando o webhook traz URL.
- Os segredos reais devem permanecer apenas no Portainer ou em cofre de segredos.
