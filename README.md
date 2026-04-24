# Chat CRM FZAP Bridge

Integração separada entre Wuzapi/FZAP e EvoCRM Community para manter o EvoCRM oficial atualizável sem alterar o código da comunidade.

## Arquitetura

- EvoCRM: `https://chat.senhorcolchao.com`
- Bridge: stack Portainer `fzap_evo_bridge`
- Inbox EvoCRM: `FZAP WhatsApp`
- Wuzapi/FZAP: `https://wuzapi.senhorcolchao.com`

Fluxo:

```text
FZAP/Wuzapi -> fzap_evo_bridge -> EvoCRM
EvoCRM -> fzap_evo_bridge -> FZAP/Wuzapi -> WhatsApp
```

## Canais

- `canal1`: Canal 1, numero `551733245765`
- `canal2`: Canal 2, numero `551733233694`

As mensagens entram em um unico inbox no EvoCRM, com identificacao do canal nos `custom_attributes` do contato/conversa.

## Deploy

No Portainer, use `docker-compose.stack.yml` como stack Swarm. Configure as variaveis:

- `WEBHOOK_SECRET`
- `EVO_API_TOKEN`
- `FZAP_CHANNELS_JSON`

Os valores reais ficam somente no Portainer, nunca no Git.

## Endpoints

- `GET /fzap/health`
- `POST /fzap/webhook/canal1?secret=...`
- `POST /fzap/webhook/canal2?secret=...`
- `POST /fzap/outgoing?secret=...`

## Escopo atual

- Texto bidirecional: suportado
- Conversa completa por inbox API: suportado
- Canal 1/Canal 2 em atributos: suportado
- Midia/audio/documentos: fallback como link/descricao quando a Wuzapi enviar URL no webhook

