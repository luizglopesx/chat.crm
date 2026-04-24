# Chat CRM FZAP Bridge

Integração separada entre Wuzapi/FZAP e EvoCRM Community para manter o EvoCRM oficial atualizável sem tocar o código da comunidade.

## Arquitetura

- EvoCRM: `https://chat.senhorcolchao.com` (stack Portainer `chat_crm`)
- Bridge: stack Portainer `fzap_evo_bridge`, exposta em `https://chat.senhorcolchao.com/fzap/...`
- Inbox EvoCRM: `FZAP WhatsApp` (identifier `fzap_whatsapp`)
- Wuzapi/FZAP: `https://wuzapi.senhorcolchao.com`

Fluxo:

```text
FZAP/Wuzapi -> fzap_evo_bridge -> EvoCRM
EvoCRM      -> fzap_evo_bridge -> FZAP/Wuzapi -> WhatsApp
```

## Canais

- `canal1`: numero `551733245765`
- `canal2`: numero `551733233694`

Ambos caem no mesmo inbox `FZAP WhatsApp`; o canal vira `custom_attributes` no contato/conversa (`fzap_channel`, `fzap_channel_key`, `fzap_phone`).

## Endpoints da bridge

- `GET  /fzap/health`
- `POST /fzap/webhook/canal1?secret=...` — webhook da Wuzapi do canal1
- `POST /fzap/webhook/canal2?secret=...` — webhook da Wuzapi do canal2
- `POST /fzap/outgoing?secret=...`        — webhook do EvoCRM (mensagens saindo pro WhatsApp)

## Variáveis de ambiente (stack `fzap_evo_bridge`)

Obrigatórias:

- `WEBHOOK_SECRET` — valor esperado no query string `?secret=...`
- `EVO_API_TOKEN` — `api_access_token` de um usuário do EvoCRM com acesso à conta
- `FZAP_CHANNELS_JSON` — mapeamento dos canais, ex.:
  ```json
  {"canal1":{"label":"Canal 1","token":"<wuzapi-token>"},"canal2":{"label":"Canal 2","token":"<wuzapi-token>"}}
  ```

Opcionais (têm default):

- `EVO_BASE_URL` (default `http://chat_crm_evo_crm:3000`) — aponta direto pro container `evo_crm` da stack `chat_crm`
- `EVO_PUBLIC_BASE_URL` (default `https://chat.senhorcolchao.com`) — usado para transformar URLs relativas de anexos do EvoCRM em URLs HTTPS públicas para a Wuzapi
- `BRIDGE_PUBLIC_BASE_URL` (default usa `EVO_PUBLIC_BASE_URL`) — URL pública usada para registrar automaticamente os webhooks da Wuzapi/FZAP
- `EVO_INBOX_IDENTIFIER` (default `fzap_whatsapp`) — usado pra resolver o `inbox_id` numérico no startup
- `EVO_INBOX_NAME` (default `FZAP WhatsApp`) — fallback se `EVO_INBOX_IDENTIFIER` não bater
- `EVO_INBOX_ID` — número; se definido, pula a auto-descoberta
- `WUZAPI_BASE_URL` (default `https://wuzapi.senhorcolchao.com`)
- `PORT` (default `3000`)

Os segredos reais ficam só no Portainer, nunca no Git.

## Como a bridge fala com o EvoCRM

A bridge usa a **API autenticada do EvoCRM** (`/api/v1/...` com header `api_access_token`), não a Public API, porque o EvoCRM Community retorna `204 No Content` com body vazio no POST de criar conversa da Public API, deixando a bridge sem `id` pra postar a mensagem. Nesta instalação, as rotas existem sem o prefixo `/accounts/{account_id}`.

Passos por mensagem entrante:

1. `resolveInboxId()` — uma vez só, lista `/inboxes` e casa por `EVO_INBOX_IDENTIFIER` ou `EVO_INBOX_NAME`. Cacheia o ID numérico.
2. `ensureContact(msg, inboxId)` — busca por telefone em `/contacts/search`, confere `contact_inboxes` procurando o `source_id`. Se achar contato só por telefone, cria `contact_inbox` ligando ao inbox FZAP. Se não achar nada, cria contato completo (contato + contact_inbox de uma vez).
3. `getOrCreateConversation(msg, ctx, inboxId)` — lista `/contacts/{id}/conversations`, pega a `open` no inbox FZAP, ou cria uma em `/conversations`.
4. `addIncomingMessage(msg, conversationId)` — `POST /conversations/{id}/messages` com `message_type: "incoming"`.

## Deploy

A stack da bridge roda a **imagem** `ghcr.io/luizglopesx/fzap-evo-bridge:latest`, buildada no GitHub Actions e publicada no GHCR. Cada push em `main` que toca `fzap-evo-bridge/**` dispara o pipeline, que no final chama um webhook do Portainer pra forçar o redeploy do serviço.

### Configuração única

Feita uma vez, nunca mais precisa:

1. **Imagem GHCR pública** — GitHub → seu perfil → Packages → `fzap-evo-bridge` → Package settings → Change visibility → Public.
2. **Webhook do Portainer** — na stack `fzap_evo_bridge` → Webhooks → Create → copiar a URL.
3. **Secret no GitHub** — repo `luizglopesx/chat.crm` → Settings → Secrets and variables → Actions → `PORTAINER_WEBHOOK_URL` com a URL acima.

### Fluxo diário

1. Editar `fzap-evo-bridge/bridge.js` (ou outros arquivos sob `fzap-evo-bridge/`).
2. `git commit && git push` no main.
3. Ver o Action rodar em https://github.com/luizglopesx/chat.crm/actions (~2 min).
4. Confirmar no log do container que a `VERSION` mudou.

### Arquivos

- `fzap-evo-bridge/bridge.js` — código da bridge (HTTP server + lógica Agent API / Wuzapi)
- `fzap-evo-bridge/Dockerfile` — `node:20-alpine` com `bridge.js` embutido
- `.github/workflows/build-bridge.yml` — build + push GHCR + trigger Portainer webhook
- `docker-compose.stack.yml` — stack Swarm com Traefik, aponta pra `ghcr.io/luizglopesx/fzap-evo-bridge:latest`

## Debug

Cada startup loga a `VERSION` (ex: `version=bridge-2026-04-24-agent-api-accountless`). Em caso de erro, o log traz a URL e método que falharam (`EvoCRM 404 GET /api/v1/...`), além de snippets do payload FZAP quando a extração de telefone falha.

## Escopo atual

- Texto entrante (WhatsApp → EvoCRM): suportado via Agent API.
- Deduplicação de mensagens entrantes: a bridge ignora o mesmo `echo_id`/ID de mensagem da Wuzapi por 10 minutos para evitar duplicidade quando o webhook é reenviado.
- Automações externas via Wuzapi/FZAP: mensagens `from_me` que não foram enviadas pela própria bridge são sincronizadas no EvoCRM como mensagens de saída, para aparecerem na timeline sem reenviar para o WhatsApp.
- Eventos `AutomationMessage` da Wuzapi/FZAP: tratados como mensagens normais; quando ignorados, o log inclui `eventName`, `fromMe` e snippet do payload para depuração.
- Webhooks da Wuzapi/FZAP: no startup, a bridge cria/atualiza seus próprios webhooks `All` e `AutomationMessage` para cada canal configurado, sem apagar webhooks de outros sistemas como o Campaign Manager.
- Texto sainte (EvoCRM/Agente de IA → WhatsApp): suportado via `/chat/send/text` da Wuzapi; HTML do editor rico é convertido para texto limpo antes do envio.
- Anexos saindo do EvoCRM para WhatsApp: imagem, áudio, vídeo, documento e sticker são encaminhados para os endpoints específicos da Wuzapi quando o webhook do EvoCRM envia `attachments` com URL pública.
- Contato/vCard e localização saindo do EvoCRM para WhatsApp: suportados quando o webhook traz `content_attributes` com `vcard` ou coordenadas.
- LID da FZAP: tenta campos `SenderPN`/`SenderAlt`/`ChatAlt` antes de cair no reverseLid.
- Mídia/áudio/documento entrando do WhatsApp para EvoCRM: a bridge tenta baixar a URL da Wuzapi e postar no EvoCRM como `attachments[]`; se falhar, usa fallback classificado com link.
- Localização entrando do WhatsApp para EvoCRM: a bridge mantém o link do Google Maps no texto e tenta anexar um preview SVG com tiles do OpenStreetMap e marcador.

## Status e próximos passos

- ✅ Automação commit → deploy (GitHub Actions + GHCR + Portainer webhook)
- ✅ Contatos e conversas sendo criados no EvoCRM (via Agent API)
- ⏳ Confirmar automações externas na timeline com `bridge-2026-04-24-automation-debug`
- ⏳ Validar sticker, vCard e localização com payload real
- ⏳ Conversas antigas vazias no CRM: não preenchem retroativamente; limpar manualmente
