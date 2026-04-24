const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.WEBHOOK_SECRET || '';
const EVO_BASE_URL = (process.env.EVO_BASE_URL || 'http://chat_crm_evo_crm:3000').replace(/\/$/, '');
const EVO_API_TOKEN = process.env.EVO_API_TOKEN || '';
const EVO_INBOX_IDENTIFIER = process.env.EVO_INBOX_IDENTIFIER || 'fzap_whatsapp';
const WUZAPI_BASE_URL = (process.env.WUZAPI_BASE_URL || 'https://wuzapi.senhorcolchao.com').replace(/\/$/, '');
const CHANNELS = JSON.parse(process.env.FZAP_CHANNELS_JSON || '{}');

function log(level, message, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...data }));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({ rawBody: body });
      }
    });
    req.on('error', reject);
  });
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function firstPath(obj, paths) {
  for (const path of paths) {
    const value = getPath(obj, path);
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return undefined;
}

function walkFind(obj, names) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase()) && child !== null && child !== undefined && String(child) !== '') {
        return child;
      }
    }
    for (const child of Object.values(value)) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return walk(obj);
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeJidValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);

  const user = value.User || value.user || value.ID || value.id || value.Phone || value.phone || '';
  const server = value.Server || value.server || value.Domain || value.domain || '';
  if (user && server) return `${user}@${server}`;
  if (user) return String(user);
  if (value.JID || value.jid) return normalizeJidValue(value.JID || value.jid);
  return '';
}

function isLidJid(value) {
  return normalizeJidValue(value).includes('@lid');
}

function jidToPhone(value) {
  let text = normalizeJidValue(value);
  if (text.includes('@lid')) return '';
  text = text.split('@')[0];
  text = text.split(':')[0];
  return digitsOnly(text);
}

function extractMessageText(message) {
  if (!message || typeof message !== 'object') return undefined;
  return firstPath(message, [
    'conversation',
    'extendedTextMessage.text',
    'imageMessage.caption',
    'videoMessage.caption',
    'documentMessage.caption',
    'buttonsResponseMessage.selectedDisplayText',
    'buttonsResponseMessage.selectedButtonId',
    'listResponseMessage.title',
    'listResponseMessage.singleSelectReply.selectedRowId',
    'templateButtonReplyMessage.selectedDisplayText',
    'templateButtonReplyMessage.selectedId'
  ]);
}

function extractMediaUrl(payload) {
  return firstPath(payload, [
    's3.url',
    'event.s3.url',
    'data.s3.url',
    'Data.s3.url',
    'data.mediaUrl',
    'Data.mediaUrl',
    'event.mediaUrl',
    'mediaUrl',
    'url',
    'downloadUrl',
    'fileUrl'
  ]) || walkFind(payload, ['mediaUrl', 'downloadUrl', 'fileUrl', 'url']);
}

async function reverseLid(channelKey, lid) {
  const channel = CHANNELS[channelKey] || {};
  if (!channel.token || !lid) return '';

  const response = await fetch(`${WUZAPI_BASE_URL}/user/lid/reverse?lid=${encodeURIComponent(lid)}`, {
    headers: { token: channel.token }
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    log('warn', 'lid reverse failed', { channelKey, status: response.status, body });
    return '';
  }
  if (typeof body.data === 'string') return body.data;
  return firstPath(body, ['data.jid', 'data.JID', 'jid', 'JID']) || '';
}

async function parseIncoming(payload, channelKey) {
  const fromMe = Boolean(firstPath(payload, [
    'event.Info.IsFromMe',
    'data.Info.IsFromMe',
    'Data.Info.IsFromMe',
    'Info.IsFromMe',
    'event.key.fromMe',
    'data.key.fromMe',
    'key.fromMe',
    'fromMe'
  ]));
  if (fromMe) return { ignore: true, reason: 'from_me' };

  const rawChatJid = firstPath(payload, [
    'event.Info.Chat',
    'event.Info.Chat.User',
    'data.Info.Chat',
    'Data.Info.Chat',
    'Info.Chat',
    'data.key.remoteJid',
    'key.remoteJid',
    'remoteJid',
    'jid',
    'from',
    'phone'
  ]);
  const chatJidText = normalizeJidValue(rawChatJid);
  if (chatJidText.includes('@g.us')) return { ignore: true, reason: 'group' };

  const rawJid = rawChatJid || firstPath(payload, [
    'event.Info.Sender',
    'event.Info.Sender.User',
    'event.key.remoteJid',
    'event.key.senderPn',
    'event.key.cleanedSenderPn',
    'data.Info.Sender',
    'Data.Info.Sender',
    'Info.Sender',
    'data.key.remoteJid',
    'key.remoteJid',
    'remoteJid',
    'jid',
    'from',
    'phone'
  ]) || walkFind(payload, ['remoteJid', 'jid']);

  let jidText = normalizeJidValue(rawJid);
  if (isLidJid(jidText)) {
    const resolvedJid = await reverseLid(channelKey, jidText);
    if (resolvedJid) jidText = normalizeJidValue(resolvedJid);
  }

  if (jidText.includes('@g.us')) return { ignore: true, reason: 'group' };

  const phone = jidToPhone(jidText);
  if (!phone) return { ignore: true, reason: 'no_phone' };

  const eventMessage = firstPath(payload, ['event.Message', 'event.message']);
  const dataMessage = firstPath(payload, ['data.Message', 'Data.Message', 'Message']);
  const rawText = extractMessageText(eventMessage) || extractMessageText(dataMessage) || firstPath(payload, [
    'event.Message.conversation',
    'event.Message.extendedTextMessage.text',
    'event.body',
    'data.Message.conversation',
    'Data.Message.conversation',
    'Message.conversation',
    'data.Message.extendedTextMessage.text',
    'Data.Message.extendedTextMessage.text',
    'Message.extendedTextMessage.text',
    'data.body',
    'body',
    'text',
    'content',
    'message'
  ]) || walkFind(payload, ['conversation', 'text', 'body', 'caption']);
  const text = rawText && typeof rawText === 'object' ? extractMessageText(rawText) : rawText;

  const mediaUrl = extractMediaUrl(payload);

  let content = String(text || '').trim();
  if (!content && mediaUrl) content = `[midia recebida] ${mediaUrl}`;
  if (!content) return { ignore: true, reason: 'no_content' };

  const pushName = firstPath(payload, [
    'event.Info.PushName',
    'data.Info.PushName',
    'Data.Info.PushName',
    'Info.PushName',
    'pushName',
    'name',
    'notifyName'
  ]) || `WhatsApp ${phone}`;

  const channel = CHANNELS[channelKey] || {};
  const sourceId = `${phone}@${channelKey}`;
  const echoId = String(firstPath(payload, [
    'event.Info.ID',
    'data.Info.ID',
    'Data.Info.ID',
    'Info.ID',
    'event.key.id',
    'data.key.id',
    'key.id',
    'id'
  ]) || `${channelKey}-${Date.now()}`);

  return {
    phone,
    sourceId,
    name: String(pushName),
    content,
    echoId,
    channelKey,
    channelLabel: channel.label || channelKey
  };
}

async function evoFetch(path, options = {}) {
  const headers = {
    'content-type': 'application/json',
    'api_access_token': EVO_API_TOKEN,
    ...(options.headers || {})
  };
  const response = await fetch(`${EVO_BASE_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`EvoCRM ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function ensureContact(msg) {
  const encoded = encodeURIComponent(msg.sourceId);
  const payload = {
    source_id: msg.sourceId,
    identifier: msg.sourceId,
    name: msg.name,
    phone_number: `+${msg.phone}`,
    custom_attributes: {
      fzap_channel: msg.channelLabel,
      fzap_channel_key: msg.channelKey,
      fzap_phone: msg.phone
    }
  };

  try {
    await evoFetch(`/public/api/v1/inboxes/${EVO_INBOX_IDENTIFIER}/contacts/${encoded}`, { method: 'GET' });
    await evoFetch(`/public/api/v1/inboxes/${EVO_INBOX_IDENTIFIER}/contacts/${encoded}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  } catch (err) {
    if (err.status !== 404) throw err;
    await evoFetch(`/public/api/v1/inboxes/${EVO_INBOX_IDENTIFIER}/contacts`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
}

async function getOrCreateConversation(msg) {
  const encoded = encodeURIComponent(msg.sourceId);
  const list = await evoFetch(`/public/api/v1/inboxes/${EVO_INBOX_IDENTIFIER}/contacts/${encoded}/conversations`, {
    method: 'GET'
  }).catch(err => {
    if (err.status === 404) return { data: [] };
    throw err;
  });

  const conversations = Array.isArray(list.data) ? list.data : Array.isArray(list) ? list : [];
  const existing = conversations.find(c => c.status === 'open') || conversations[0];
  if (existing) return existing.display_id || existing.id;

  const created = await evoFetch(`/public/api/v1/inboxes/${EVO_INBOX_IDENTIFIER}/contacts/${encoded}/conversations`, {
    method: 'POST',
    body: JSON.stringify({
      custom_attributes: {
        fzap_channel: msg.channelLabel,
        fzap_channel_key: msg.channelKey,
        fzap_phone: msg.phone
      }
    })
  });
  const data = created.data || created;
  return data.display_id || data.id;
}

async function addIncomingMessage(msg, conversationId) {
  return evoFetch(`/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify(compactObject({
      content: msg.content,
      message_type: 'incoming',
      private: false,
      content_type: 'text',
      content_attributes: {
        external_id: msg.echoId,
        fzap_channel: msg.channelLabel,
        fzap_channel_key: msg.channelKey,
        fzap_phone: msg.phone
      },
      echo_id: msg.echoId
    }))
  });
}

function channelFromSource(sourceId) {
  const text = String(sourceId || '');
  const [, channelKey] = text.split('@');
  return channelKey || '';
}

function phoneFromSource(sourceId, sender) {
  const text = String(sourceId || '');
  const [phone] = text.split('@');
  return digitsOnly(phone || sender?.phone_number || sender?.identifier || '');
}

async function sendToWuzapi(payload) {
  if (payload.event !== 'message_created') return { ignored: 'event' };
  if (!['outgoing', 'template'].includes(String(payload.message_type))) return { ignored: 'message_type' };
  if (payload.private) return { ignored: 'private' };

  const sourceId = payload?.conversation?.contact_inbox?.source_id || payload.source_id || '';
  const channelKey = payload?.conversation?.custom_attributes?.fzap_channel_key || channelFromSource(sourceId);
  const channel = CHANNELS[channelKey];
  if (!channel?.token) throw new Error(`missing channel token for ${channelKey || 'unknown'}`);

  const phone = phoneFromSource(sourceId, payload.sender || payload?.conversation?.meta?.sender);
  if (!phone) throw new Error('missing destination phone');

  const content = String(payload.content || '').trim();
  if (!content) return { ignored: 'empty_content' };

  const response = await fetch(`${WUZAPI_BASE_URL}/chat/send/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', token: channel.token },
    body: JSON.stringify({
      phone,
      body: content,
      check: true,
      linkPreview: true
    })
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`Wuzapi ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return { sent: true, channel: channel.label || channelKey, phone, response: body };
}

async function handleIncoming(req, res, channelKey) {
  const payload = await readBody(req);
  const msg = await parseIncoming(payload, channelKey);
  if (msg.ignore) {
    log('info', 'incoming ignored', { channelKey, reason: msg.reason });
    return sendJson(res, 200, { ok: true, ignored: msg.reason });
  }
  await ensureContact(msg);
  const conversationId = await getOrCreateConversation(msg);
  await addIncomingMessage(msg, conversationId);
  log('info', 'incoming synced', { channelKey, phone: msg.phone, conversationId });
  sendJson(res, 200, { ok: true, conversationId });
}

async function handleOutgoing(req, res) {
  const payload = await readBody(req);
  const result = await sendToWuzapi(payload);
  log('info', 'outgoing handled', { result });
  sendJson(res, 200, { ok: true, result });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health' || url.pathname === '/fzap/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (SECRET && url.searchParams.get('secret') !== SECRET) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    const incomingMatch = url.pathname.match(/^\/fzap\/webhook\/([^/]+)$/);
    if (req.method === 'POST' && incomingMatch) return await handleIncoming(req, res, incomingMatch[1]);
    if (req.method === 'POST' && url.pathname === '/fzap/outgoing') return await handleOutgoing(req, res);

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log('error', err.message, { status: err.status, body: err.body, stack: err.stack });
    sendJson(res, 500, { ok: false, error: err.message, details: err.body });
  }
});

server.listen(PORT, () => log('info', 'fzap evo bridge listening', { port: PORT }));
