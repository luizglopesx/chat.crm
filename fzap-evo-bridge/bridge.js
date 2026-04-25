const http = require('http');

const VERSION = 'bridge-2026-04-25-debug-message-create';
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.WEBHOOK_SECRET || '';
const EVO_BASE_URL = (process.env.EVO_BASE_URL || 'http://chat_crm_evo_crm:3000').replace(/\/$/, '');
const EVO_PUBLIC_BASE_URL = (process.env.EVO_PUBLIC_BASE_URL || 'https://chat.senhorcolchao.com').replace(/\/$/, '');
const BRIDGE_PUBLIC_BASE_URL = (process.env.BRIDGE_PUBLIC_BASE_URL || EVO_PUBLIC_BASE_URL).replace(/\/$/, '');
const EVO_API_TOKEN = process.env.EVO_API_TOKEN || '';
const EVO_INBOX_ID_ENV = process.env.EVO_INBOX_ID ? Number(process.env.EVO_INBOX_ID) : 0;
const EVO_INBOX_IDENTIFIER = process.env.EVO_INBOX_IDENTIFIER || 'fzap_whatsapp';
const EVO_INBOX_NAME = process.env.EVO_INBOX_NAME || 'FZAP WhatsApp';
const WUZAPI_BASE_URL = (process.env.WUZAPI_BASE_URL || 'https://wuzapi.senhorcolchao.com').replace(/\/$/, '');
const CHANNELS = JSON.parse(process.env.FZAP_CHANNELS_JSON || '{}');
const INCOMING_DEDUPE_TTL_MS = 10 * 60 * 1000;
const WUZAPI_WEBHOOK_SYNC_INTERVAL_MS = Number(process.env.WUZAPI_WEBHOOK_SYNC_INTERVAL_MS || 5 * 60 * 1000);
const recentIncomingMessages = new Map();
const recentBridgeOutboundIds = new Map();
const recentDiagnostics = [];

function log(level, message, data = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...data };
  recentDiagnostics.push(entry);
  while (recentDiagnostics.length > 200) recentDiagnostics.shift();
  console.log(JSON.stringify(entry));
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

function summarizePayload(payload) {
  try {
    const text = JSON.stringify(payload);
    if (!text) return '';
    return text.length > 2000 ? `${text.slice(0, 2000)}...[truncated ${text.length}]` : text;
  } catch {
    return String(payload);
  }
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeOutgoingContent(value) {
  let text = String(value || '');
  text = text
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>\s*<\s*p[^>]*>/gi, '\n\n')
    .replace(/<\s*\/?(p|div|li|ul|ol|blockquote|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  text = decodeHtmlEntities(text);
  text = text
    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '*$1*')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function isOutgoingMessage(payload) {
  const type = String(payload.message_type ?? '').toLowerCase();
  if (['incoming', '0'].includes(type)) return false;
  if (['outgoing', 'template', '1', '3'].includes(type)) return true;

  const senderType = String(payload.sender?.type || payload.sender_type || '').toLowerCase();
  if (senderType.includes('agent') || senderType.includes('bot')) return true;

  return false;
}

function incomingEventName(payload) {
  if (typeof payload?.event === 'string') return payload.event;
  return String(firstPath(payload, [
    'event.Event',
    'event.event',
    'data.Event',
    'data.event',
    'Data.Event',
    'Data.event',
    'Event',
    'eventType',
    'type'
  ]) || '');
}

function incomingMessageObject(payload) {
  return firstPath(payload, [
    'event.Message',
    'event.AutomationMessage',
    'event.message',
    'event.automationMessage',
    'data.Message',
    'data.AutomationMessage',
    'data.message',
    'data.automationMessage',
    'Data.Message',
    'Data.AutomationMessage',
    'Data.message',
    'Data.automationMessage',
    'Message',
    'AutomationMessage',
    'message',
    'automationMessage'
  ]);
}

function isBridgeSyncedOutgoing(payload) {
  const attrs = payload.content_attributes || payload.additional_attributes || {};
  return Boolean(attrs.fzap_synced_from_me || attrs.fzap_bridge_sync_only);
}

function cleanupTimedMap(map, ttlMs, now = Date.now()) {
  for (const [key, ts] of map.entries()) {
    if (now - ts > ttlMs) map.delete(key);
  }
}

function markBridgeOutboundId(id) {
  if (!id) return;
  cleanupTimedMap(recentBridgeOutboundIds, INCOMING_DEDUPE_TTL_MS);
  recentBridgeOutboundIds.set(String(id), Date.now());
}

function isBridgeOutboundId(id) {
  if (!id) return false;
  cleanupTimedMap(recentBridgeOutboundIds, INCOMING_DEDUPE_TTL_MS);
  const text = String(id);
  return recentBridgeOutboundIds.has(text) || text.startsWith('EVOCRM');
}

function outgoingWuzapiId(payload, suffix = '') {
  const seed = String(payload.id || payload.echo_id || Date.now()).replace(/\W/g, '').slice(-24);
  return `EVOCRM${seed}${suffix}`;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function absoluteUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith(EVO_BASE_URL)) return `${EVO_PUBLIC_BASE_URL}${text.slice(EVO_BASE_URL.length)}`;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${EVO_PUBLIC_BASE_URL}${text}`;
  return text;
}

function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function attachmentUrl(attachment) {
  return absoluteUrl(firstPath(attachment, [
    'data_url',
    'download_url',
    'downloadUrl',
    'file_url',
    'fileUrl',
    'url',
    'attachment.url',
    'attachment.data_url'
  ]));
}

function attachmentName(attachment, url = '') {
  return firstPath(attachment, [
    'file_name',
    'filename',
    'name',
    'title',
    'attachment.file_name',
    'attachment.filename'
  ]) || filenameFromUrl(url) || 'arquivo';
}

function attachmentMime(attachment) {
  return String(firstPath(attachment, [
    'mime_type',
    'mimeType',
    'content_type',
    'contentType',
    'attachment.mime_type',
    'attachment.content_type'
  ]) || '').toLowerCase();
}

function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('pdf')) return 'pdf';
  return 'bin';
}

function contentDispositionFilename(value) {
  const text = String(value || '');
  const utf8 = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1]);
  const quoted = text.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1];
  const plain = text.match(/filename=([^;]+)/i);
  return plain ? plain[1].trim() : '';
}

function attachmentType(attachment) {
  const explicit = String(firstPath(attachment, [
    'file_type',
    'fileType',
    'type',
    'message_type',
    'attachment.file_type'
  ]) || '').toLowerCase();
  const mime = attachmentMime(attachment);
  const name = attachmentName(attachment).toLowerCase();

  if (explicit.includes('sticker') || name.endsWith('.webp')) return 'sticker';
  if (explicit.includes('image') || mime.startsWith('image/')) return 'image';
  if (explicit.includes('audio') || mime.startsWith('audio/')) return 'audio';
  if (explicit.includes('video') || mime.startsWith('video/')) return 'video';
  return 'document';
}

function outgoingAttachments(payload) {
  return [
    ...asArray(payload.attachments),
    ...asArray(payload.attachment),
    ...asArray(payload.message?.attachments)
  ].filter(Boolean);
}

function outgoingLocation(payload) {
  const attrs = payload.content_attributes || payload.additional_attributes || {};
  const latitude = firstPath(payload, ['latitude', 'location.latitude', 'content_attributes.latitude'])
    ?? attrs.latitude
    ?? attrs.lat;
  const longitude = firstPath(payload, ['longitude', 'location.longitude', 'content_attributes.longitude'])
    ?? attrs.longitude
    ?? attrs.lng
    ?? attrs.long;
  if (latitude === undefined || longitude === undefined) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    latitude: lat,
    longitude: lng,
    name: firstPath(payload, ['location.name', 'content_attributes.name']) || attrs.name || attrs.location_name,
    address: firstPath(payload, ['location.address', 'content_attributes.address']) || attrs.address,
    url: firstPath(payload, ['location.url', 'content_attributes.url']) || attrs.url
  };
}

function outgoingContact(payload) {
  const attrs = payload.content_attributes || payload.additional_attributes || {};
  const vcard = firstPath(payload, ['vcard', 'contact.vcard', 'content_attributes.vcard']) || attrs.vcard;
  if (!vcard) return null;
  return {
    name: firstPath(payload, ['contact.name', 'content_attributes.name']) || attrs.name || attrs.full_name || 'Contato',
    vcard
  };
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

function incomingMediaKind(message, payload) {
  const keys = message && typeof message === 'object' ? Object.keys(message) : [];
  const byKey = keys.find(key => /Message$/i.test(key));
  const typeText = String(firstPath(payload, [
    'event.Info.Type',
    'data.Info.Type',
    'Data.Info.Type',
    'type',
    'messageType',
    'mediaType'
  ]) || byKey || '').toLowerCase();

  if (typeText.includes('image')) return 'imagem';
  if (typeText.includes('audio') || typeText.includes('ptt')) return 'audio';
  if (typeText.includes('video')) return 'video';
  if (typeText.includes('document')) return 'documento';
  if (typeText.includes('sticker')) return 'sticker';
  if (typeText.includes('contact') || typeText.includes('vcard')) return 'contato';
  if (typeText.includes('location')) return 'localizacao';
  return 'midia';
}

function incomingMediaFileName(payload, mediaUrl, mediaKind, mimeType = '') {
  return firstPath(payload, [
    'event.Message.documentMessage.fileName',
    'data.Message.documentMessage.fileName',
    'Data.Message.documentMessage.fileName',
    'Message.documentMessage.fileName',
    'fileName',
    'filename',
    'name'
  ]) || filenameFromUrl(mediaUrl) || `${mediaKind || 'midia'}-${Date.now()}.${extensionForMime(mimeType)}`;
}

function incomingLocationText(message) {
  const location = incomingLocationDetails(message);
  if (!location) return '';
  return [`[localizacao recebida]`, location.name, location.address, location.url].filter(Boolean).join('\n');
}

function incomingLocationDetails(message) {
  const latitude = firstPath(message, ['locationMessage.degreesLatitude', 'liveLocationMessage.degreesLatitude']);
  const longitude = firstPath(message, ['locationMessage.degreesLongitude', 'liveLocationMessage.degreesLongitude']);
  if (latitude === undefined || longitude === undefined) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const name = firstPath(message, ['locationMessage.name', 'liveLocationMessage.name']);
  const address = firstPath(message, ['locationMessage.address', 'liveLocationMessage.address']);
  return {
    latitude: lat,
    longitude: lng,
    name,
    address,
    url: `https://maps.google.com/?q=${lat},${lng}`
  };
}

function incomingContactText(message) {
  const displayName = firstPath(message, ['contactMessage.displayName', 'contactsArrayMessage.contacts.0.displayName']);
  const vcard = firstPath(message, ['contactMessage.vcard', 'contactsArrayMessage.contacts.0.vcard']);
  if (!displayName && !vcard) return '';
  return [`[contato recebido] ${displayName || ''}`.trim(), vcard].filter(Boolean).join('\n');
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
  const eventName = incomingEventName(payload);
  const fromMe = Boolean(firstPath(payload, [
    'event.Info.IsFromMe',
    'event.Info.MessageSource.IsFromMe',
    'event.Info.messageSource.isFromMe',
    'data.Info.IsFromMe',
    'data.Info.MessageSource.IsFromMe',
    'data.Info.messageSource.isFromMe',
    'Data.Info.IsFromMe',
    'Data.Info.MessageSource.IsFromMe',
    'Data.Info.messageSource.isFromMe',
    'Info.IsFromMe',
    'Info.MessageSource.IsFromMe',
    'Info.messageSource.isFromMe',
    'event.key.fromMe',
    'data.key.fromMe',
    'key.fromMe',
    'fromMe'
  ]));

  const rawChatJid = firstPath(payload, [
    'event.Info.Chat',
    'event.Info.Chat.User',
    'event.Info.MessageSource.Chat',
    'event.Info.MessageSource.ChatAlt',
    'event.Info.messageSource.chat',
    'event.Info.messageSource.chatAlt',
    'data.Info.Chat',
    'data.Info.MessageSource.Chat',
    'data.Info.MessageSource.ChatAlt',
    'data.Info.messageSource.chat',
    'data.Info.messageSource.chatAlt',
    'Data.Info.Chat',
    'Data.Info.MessageSource.Chat',
    'Data.Info.MessageSource.ChatAlt',
    'Data.Info.messageSource.chat',
    'Data.Info.messageSource.chatAlt',
    'Info.Chat',
    'Info.MessageSource.Chat',
    'Info.MessageSource.ChatAlt',
    'Info.messageSource.chat',
    'Info.messageSource.chatAlt',
    'event.Info.Recipient',
    'event.Info.Receiver',
    'event.Info.To',
    'data.Info.Recipient',
    'data.Info.Receiver',
    'data.Info.To',
    'Data.Info.Recipient',
    'Data.Info.Receiver',
    'Data.Info.To',
    'data.key.remoteJid',
    'key.remoteJid',
    'remoteJid',
    'jid',
    'from',
    'phone'
  ]);
  const chatJidText = normalizeJidValue(rawChatJid);
  if (chatJidText.includes('@g.us')) return { ignore: true, reason: 'group' };

  const senderAltJid = firstPath(payload, [
    'event.Info.SenderPN',
    'event.Info.SenderPn',
    'event.Info.SenderAlt',
    'event.Info.ChatAlt',
    'event.Info.MessageSource.SenderAlt',
    'event.Info.MessageSource.ChatAlt',
    'event.Info.messageSource.senderAlt',
    'event.Info.messageSource.chatAlt',
    'data.Info.SenderPN',
    'data.Info.SenderAlt',
    'data.Info.ChatAlt',
    'data.Info.MessageSource.SenderAlt',
    'data.Info.MessageSource.ChatAlt',
    'data.Info.messageSource.senderAlt',
    'data.Info.messageSource.chatAlt',
    'Data.Info.SenderPN',
    'Data.Info.SenderAlt',
    'Data.Info.ChatAlt',
    'Data.Info.MessageSource.SenderAlt',
    'Data.Info.MessageSource.ChatAlt',
    'Data.Info.messageSource.senderAlt',
    'Data.Info.messageSource.chatAlt',
    'Info.SenderPN',
    'Info.SenderAlt',
    'Info.ChatAlt',
    'Info.MessageSource.SenderAlt',
    'Info.MessageSource.ChatAlt',
    'Info.messageSource.senderAlt',
    'Info.messageSource.chatAlt',
    'event.key.senderPn',
    'event.key.cleanedSenderPn',
    'data.key.senderPn',
    'key.senderPn',
    'senderPn'
  ]);

  const recipientAltJid = firstPath(payload, [
    'event.Info.RecipientAlt',
    'event.Info.ChatAlt',
    'event.Info.MessageSource.RecipientAlt',
    'event.Info.MessageSource.ChatAlt',
    'event.Info.messageSource.recipientAlt',
    'event.Info.messageSource.chatAlt',
    'data.Info.RecipientAlt',
    'data.Info.ChatAlt',
    'data.Info.MessageSource.RecipientAlt',
    'data.Info.MessageSource.ChatAlt',
    'data.Info.messageSource.recipientAlt',
    'data.Info.messageSource.chatAlt',
    'Data.Info.RecipientAlt',
    'Data.Info.ChatAlt',
    'Data.Info.MessageSource.RecipientAlt',
    'Data.Info.MessageSource.ChatAlt',
    'Data.Info.messageSource.recipientAlt',
    'Data.Info.messageSource.chatAlt',
    'Info.RecipientAlt',
    'Info.ChatAlt',
    'Info.MessageSource.RecipientAlt',
    'Info.MessageSource.ChatAlt',
    'Info.messageSource.recipientAlt',
    'Info.messageSource.chatAlt'
  ]);

  const rawSenderJid = firstPath(payload, [
    'event.Info.Sender',
    'event.Info.Sender.User',
    'event.Info.MessageSource.Sender',
    'event.Info.MessageSource.SenderAlt',
    'event.Info.messageSource.sender',
    'event.Info.messageSource.senderAlt',
    'data.Info.Sender',
    'data.Info.MessageSource.Sender',
    'data.Info.MessageSource.SenderAlt',
    'data.Info.messageSource.sender',
    'data.Info.messageSource.senderAlt',
    'Data.Info.Sender',
    'Data.Info.MessageSource.Sender',
    'Data.Info.MessageSource.SenderAlt',
    'Data.Info.messageSource.sender',
    'Data.Info.messageSource.senderAlt',
    'Info.Sender',
    'Info.MessageSource.Sender',
    'Info.MessageSource.SenderAlt',
    'Info.messageSource.sender',
    'Info.messageSource.senderAlt',
    'event.key.remoteJid',
    'data.key.remoteJid',
    'key.remoteJid',
    'remoteJid',
    'jid',
    'from',
    'phone'
  ]) || walkFind(payload, ['remoteJid', 'jid']);

  const candidates = (fromMe
    ? [recipientAltJid, rawChatJid]
    : [senderAltJid, rawChatJid, rawSenderJid]
  ).filter(Boolean);
  let jidText = '';
  for (const cand of candidates) {
    const text = normalizeJidValue(cand);
    if (text && !isLidJid(text)) { jidText = text; break; }
  }
  if (!jidText) {
    for (const cand of candidates) {
      const text = normalizeJidValue(cand);
      if (text && isLidJid(text)) {
        const resolved = await reverseLid(channelKey, text);
        if (resolved) { jidText = normalizeJidValue(resolved); break; }
      }
    }
  }

  if (jidText.includes('@g.us')) return { ignore: true, reason: 'group' };

  const phone = jidToPhone(jidText);
  if (!phone) {
    log('warn', 'no_phone debug', {
      channelKey,
      eventName,
      fromMe,
      chatJid: chatJidText,
      senderJid: normalizeJidValue(rawSenderJid),
      senderAltJid: normalizeJidValue(senderAltJid),
      recipientAltJid: normalizeJidValue(recipientAltJid),
      payloadSnippet: summarizePayload(payload)
    });
    return { ignore: true, reason: 'no_phone' };
  }

  const messageObject = incomingMessageObject(payload);
  const rawText = extractMessageText(messageObject) || firstPath(payload, [
    'event.Message.conversation',
    'event.AutomationMessage.conversation',
    'event.Message.extendedTextMessage.text',
    'event.AutomationMessage.extendedTextMessage.text',
    'event.body',
    'data.Message.conversation',
    'data.AutomationMessage.conversation',
    'Data.Message.conversation',
    'Data.AutomationMessage.conversation',
    'Message.conversation',
    'AutomationMessage.conversation',
    'data.Message.extendedTextMessage.text',
    'data.AutomationMessage.extendedTextMessage.text',
    'Data.Message.extendedTextMessage.text',
    'Data.AutomationMessage.extendedTextMessage.text',
    'Message.extendedTextMessage.text',
    'AutomationMessage.extendedTextMessage.text',
    'data.body',
    'body',
    'text',
    'content',
    'message'
  ]) || walkFind(payload, ['conversation', 'text', 'body', 'caption']);
  const text = rawText && typeof rawText === 'object' ? extractMessageText(rawText) : rawText;

  const mediaUrl = extractMediaUrl(payload);
  const mediaKind = mediaUrl ? incomingMediaKind(messageObject, payload) : '';
  const location = incomingLocationDetails(messageObject);
  const locationText = incomingLocationText(messageObject);
  const contactText = incomingContactText(messageObject);

  let content = String(text || '').trim();
  if (!content && locationText) content = locationText;
  if (!content && contactText) content = contactText;
  if (!content && mediaUrl) content = `[${mediaKind} recebida]`;
  if (!content) {
    return {
      ignore: true,
      reason: 'no_content',
      debug: {
        eventName,
        fromMe,
        echoCandidate: firstPath(payload, ['event.Info.ID', 'data.Info.ID', 'Data.Info.ID', 'Info.ID', 'id']),
        payloadSnippet: summarizePayload(payload)
      }
    };
  }

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

  if (fromMe && isBridgeOutboundId(echoId)) {
    return { ignore: true, reason: 'from_me_bridge_echo', debug: { eventName, echoId } };
  }

  return {
    phone,
    sourceId,
    name: String(pushName),
    content,
    fromMe,
    eventName,
    messageType: fromMe ? 'outgoing' : 'incoming',
    mediaUrl,
    mediaKind,
    mediaFileName: mediaUrl ? incomingMediaFileName(payload, mediaUrl, mediaKind) : '',
    location,
    echoId,
    channelKey,
    channelLabel: channel.label || channelKey
  };
}

function cleanupIncomingDedupe(now = Date.now()) {
  cleanupTimedMap(recentIncomingMessages, INCOMING_DEDUPE_TTL_MS, now);
}

function markIncomingMessage(msg) {
  if (!msg.echoId || msg.echoId.includes(`${msg.channelKey}-`)) return { duplicate: false, key: '' };
  const now = Date.now();
  cleanupIncomingDedupe(now);
  const key = `${msg.channelKey}:${msg.echoId}`;
  if (recentIncomingMessages.has(key)) return { duplicate: true, key };
  recentIncomingMessages.set(key, now);
  return { duplicate: false, key };
}

async function evoFetch(path, options = {}) {
  const headers = {
    'content-type': 'application/json',
    'api_access_token': EVO_API_TOKEN,
    ...(options.headers || {})
  };
  const method = options.method || 'GET';
  const response = await fetch(`${EVO_BASE_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`EvoCRM ${response.status} ${method} ${path}`);
    err.status = response.status;
    err.body = body;
    err.path = path;
    err.method = method;
    throw err;
  }
  if (typeof body === 'object' && body !== null) {
    Object.defineProperty(body, '__rawText', { value: text, enumerable: false });
    Object.defineProperty(body, '__status', { value: response.status, enumerable: false });
  }
  return body;
}

async function evoFetchForm(path, form) {
  const response = await fetch(`${EVO_BASE_URL}${path}`, {
    method: 'POST',
    headers: { api_access_token: EVO_API_TOKEN },
    body: form
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`EvoCRM ${response.status} POST ${path}`);
    err.status = response.status;
    err.body = body;
    err.path = path;
    err.method = 'POST';
    throw err;
  }
  return body;
}

let resolvedInboxId = EVO_INBOX_ID_ENV || 0;
let inboxResolutionPromise = null;

async function resolveInboxId() {
  if (resolvedInboxId) return resolvedInboxId;
  if (!inboxResolutionPromise) {
    inboxResolutionPromise = (async () => {
      const resp = await evoFetch('/api/v1/inboxes');
      const items = Array.isArray(resp?.payload) ? resp.payload
        : Array.isArray(resp?.data?.payload) ? resp.data.payload
        : Array.isArray(resp?.data) ? resp.data
        : Array.isArray(resp) ? resp
        : [];
      const match = items.find(i => i?.inbox_identifier === EVO_INBOX_IDENTIFIER)
        || items.find(i => i?.name === EVO_INBOX_NAME)
        || items.find(i => String(i?.name || '').toLowerCase() === String(EVO_INBOX_NAME).toLowerCase());
      if (!match?.id) {
        inboxResolutionPromise = null;
        throw new Error(`inbox not found (identifier="${EVO_INBOX_IDENTIFIER}" name="${EVO_INBOX_NAME}")`);
      }
      resolvedInboxId = match.id;
      log('info', 'inbox resolved', { id: resolvedInboxId, name: match.name, identifier: match.inbox_identifier });
      return resolvedInboxId;
    })();
  }
  return inboxResolutionPromise;
}

async function findContactBySourceId(sourceId, phone) {
  const q = encodeURIComponent(phone);
  const resp = await evoFetch(
    `/api/v1/contacts/search?q=${q}&include=contact_inboxes`
  ).catch(err => { if (err.status === 404) return { payload: [] }; throw err; });
  const items = Array.isArray(resp?.payload) ? resp.payload
    : Array.isArray(resp?.data?.payload) ? resp.data.payload
    : Array.isArray(resp?.data) ? resp.data
    : [];
  for (const contact of items) {
    const ci = (contact.contact_inboxes || []).find(c => c.source_id === sourceId);
    if (ci) return { contactId: contact.id, contactInboxId: ci.id, sourceId: ci.source_id };
  }
  const byPhone = items.find(c => digitsOnly(c.phone_number) === phone);
  if (byPhone) return { contactId: byPhone.id, contactInboxId: null, sourceId: null };
  return null;
}

async function createContactInbox(contactId, sourceId, inboxId) {
  const resp = await evoFetch(`/api/v1/contacts/${contactId}/contact_inboxes`, {
    method: 'POST',
    body: JSON.stringify({ inbox_id: inboxId, source_id: sourceId })
  });
  const data = resp?.payload || resp?.data || resp;
  return { contactInboxId: data?.id, sourceId: data?.source_id || sourceId };
}

async function ensureContact(msg, inboxId) {
  const existing = await findContactBySourceId(msg.sourceId, msg.phone);
  if (existing?.contactInboxId) {
    log('info', 'contact found', { contactId: existing.contactId, contactInboxId: existing.contactInboxId });
    return existing;
  }
  if (existing?.contactId) {
    const ci = await createContactInbox(existing.contactId, msg.sourceId, inboxId);
    log('info', 'contact inbox created for existing contact', { contactId: existing.contactId, ...ci });
    return { contactId: existing.contactId, ...ci };
  }

  const created = await evoFetch('/api/v1/contacts', {
    method: 'POST',
    body: JSON.stringify({
      inbox_id: inboxId,
      source_id: msg.sourceId,
      name: msg.name,
      phone_number: `+${msg.phone}`,
      identifier: msg.sourceId,
      custom_attributes: {
        fzap_channel: msg.channelLabel,
        fzap_channel_key: msg.channelKey,
        fzap_phone: msg.phone
      }
    })
  });
  const data = created?.payload || created?.data || created;
  const contact = data?.contact || data;
  const contactInbox = data?.contact_inbox;
  const result = {
    contactId: contact?.id,
    contactInboxId: contactInbox?.id,
    sourceId: contactInbox?.source_id || msg.sourceId
  };
  log('info', 'contact created', result);
  if (!result.contactId) throw new Error('contact create response missing id');
  if (!result.contactInboxId) {
    const ci = await createContactInbox(result.contactId, msg.sourceId, inboxId);
    result.contactInboxId = ci.contactInboxId;
    result.sourceId = ci.sourceId;
  }
  return result;
}

async function getOrCreateConversation(msg, ctx, inboxId) {
  const list = await evoFetch(`/api/v1/contacts/${ctx.contactId}/conversations`)
    .catch(err => { if (err.status === 404) return { payload: [] }; throw err; });
  const items = Array.isArray(list?.payload) ? list.payload
    : Array.isArray(list?.data?.payload) ? list.data.payload
    : Array.isArray(list?.data) ? list.data
    : [];
  const existing = items.find(c => c.inbox_id === inboxId && c.status === 'open')
    || items.find(c => c.inbox_id === inboxId);
  if (existing?.id) {
    log('info', 'conversation found', { id: existing.id, status: existing.status });
    return existing.id;
  }

  const created = await evoFetch('/api/v1/conversations', {
    method: 'POST',
    body: JSON.stringify({
      source_id: msg.sourceId,
      inbox_id: inboxId,
      contact_id: ctx.contactId,
      status: 'open',
      custom_attributes: {
        fzap_channel: msg.channelLabel,
        fzap_channel_key: msg.channelKey,
        fzap_phone: msg.phone
      }
    })
  });
  const data = created?.payload || created?.data || created;
  const convId = data?.id || data?.conversation?.id;
  log('info', 'conversation created', { id: convId, status: created?.__status });
  if (!convId) throw new Error(`conversation create missing id, raw=${summarizePayload(created)}`);
  return convId;
}

async function addIncomingMessage(msg, conversationId) {
  if (msg.location) {
    try {
      return await addIncomingLocationMessage(msg, conversationId);
    } catch (err) {
      log('warn', 'incoming location preview failed, falling back to text', {
        conversationId,
        echoId: msg.echoId,
        status: err.status,
        body: err.body,
        error: err.message
      });
    }
  }

  if (msg.mediaUrl) {
    try {
      return await addIncomingMediaMessage(msg, conversationId);
    } catch (err) {
      log('warn', 'incoming media upload failed, falling back to link', {
        conversationId,
        echoId: msg.echoId,
        mediaUrl: msg.mediaUrl,
        status: err.status,
        body: err.body,
        error: err.message
      });
      msg.content = `${msg.content}\n${msg.mediaUrl}`.trim();
    }
  }

  const payload = compactObject({
    content: msg.content,
    message_type: msg.messageType || 'incoming',
    private: false,
    echo_id: msg.echoId,
    content_attributes: compactObject({
      fzap_echo_id: msg.echoId,
      fzap_channel_key: msg.channelKey,
      fzap_synced_from_me: msg.fromMe || undefined,
      fzap_bridge_sync_only: msg.fromMe || undefined
    })
  });
  const result = await evoFetch(`/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const messageId = result?.id || result?.payload?.id || result?.data?.id;
  log('info', 'message created', {
    conversationId,
    messageId,
    messageType: payload.message_type,
    fromMe: Boolean(msg.fromMe),
    status: result?.__status,
    responseKeys: result ? Object.keys(result).slice(0, 20).join(',') : 'null',
    responseSnippet: summarizePayload(result)
  });
  return result;
}

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat, zoom) {
  const rad = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * 2 ** zoom);
}

function lonToPixelX(lon, zoom) {
  return ((lon + 180) / 360) * 2 ** zoom * 256;
}

function latToPixelY(lat, zoom) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * 2 ** zoom * 256;
}

async function fetchTileDataUrl(x, y, zoom) {
  const response = await fetch(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, {
    headers: {
      'user-agent': 'Chat CRM Senhor Colchao FZAP Bridge/1.0'
    }
  });
  if (!response.ok) throw new Error(`tile download ${response.status}`);
  const bytes = await response.arrayBuffer();
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function buildLocationMapSvg(location) {
  const zoom = 16;
  const centerX = lonToTileX(location.longitude, zoom);
  const centerY = latToTileY(location.latitude, zoom);
  const originTileX = centerX - 1;
  const originTileY = centerY - 1;
  const originPixelX = originTileX * 256;
  const originPixelY = originTileY * 256;
  const markerX = lonToPixelX(location.longitude, zoom) - originPixelX;
  const markerY = latToPixelY(location.latitude, zoom) - originPixelY;
  const tiles = [];

  for (let dy = 0; dy < 3; dy += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      try {
        const href = await fetchTileDataUrl(originTileX + dx, originTileY + dy, zoom);
        tiles.push(`<image href="${href}" x="${dx * 256}" y="${dy * 256}" width="256" height="256"/>`);
      } catch (err) {
        log('warn', 'map tile failed', { x: originTileX + dx, y: originTileY + dy, zoom, error: err.message });
        tiles.push(`<rect x="${dx * 256}" y="${dy * 256}" width="256" height="256" fill="#e5e7eb"/>`);
      }
    }
  }

  const label = decodeHtmlEntities(location.name || location.address || 'Localizacao recebida')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="768" height="840" viewBox="0 0 768 840">
  <rect width="768" height="840" fill="#f8fafc"/>
  <g>${tiles.join('')}</g>
  <g transform="translate(${markerX.toFixed(2)} ${markerY.toFixed(2)})">
    <path d="M0 30 C-32 -12 -18 -48 0 -48 C18 -48 32 -12 0 30Z" fill="#ef4444" stroke="#991b1b" stroke-width="4"/>
    <circle cx="0" cy="-22" r="12" fill="#fff"/>
  </g>
  <rect x="0" y="768" width="768" height="72" fill="#ffffff"/>
  <text x="24" y="800" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#111827">${label}</text>
  <text x="24" y="828" font-family="Arial, sans-serif" font-size="18" fill="#4b5563">${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)} - OpenStreetMap contributors</text>
</svg>`;
}

async function addIncomingLocationMessage(msg, conversationId) {
  const svg = await buildLocationMapSvg(msg.location);
  const form = new FormData();
  form.append('content', msg.content);
  form.append('message_type', msg.messageType || 'incoming');
  form.append('private', 'false');
  form.append('echo_id', msg.echoId);
  form.append('content_attributes', JSON.stringify(compactObject({
    fzap_echo_id: msg.echoId,
    fzap_channel_key: msg.channelKey,
    fzap_synced_from_me: msg.fromMe || undefined,
    fzap_bridge_sync_only: msg.fromMe || undefined
  })));
  form.append('attachments[]', new Blob([svg], { type: 'image/svg+xml' }), `localizacao-${msg.echoId || Date.now()}.svg`);

  const result = await evoFetchForm(`/api/v1/conversations/${conversationId}/messages`, form);
  log('info', 'location message created', {
    conversationId,
    messageId: result?.id,
    latitude: msg.location.latitude,
    longitude: msg.location.longitude
  });
  return result;
}

async function downloadIncomingMedia(msg) {
  const channel = CHANNELS[msg.channelKey] || {};
  const headers = channel.token ? { token: channel.token } : {};
  const response = await fetch(msg.mediaUrl, { headers });
  if (!response.ok) {
    const err = new Error(`media download ${response.status}`);
    err.status = response.status;
    err.body = { url: msg.mediaUrl };
    throw err;
  }

  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  const disposition = response.headers.get('content-disposition') || '';
  const fileName = contentDispositionFilename(disposition)
    || msg.mediaFileName
    || incomingMediaFileName({}, msg.mediaUrl, msg.mediaKind, mimeType);
  const bytes = await response.arrayBuffer();
  return {
    blob: new Blob([bytes], { type: mimeType }),
    fileName,
    mimeType,
    size: bytes.byteLength
  };
}

async function addIncomingMediaMessage(msg, conversationId) {
  const media = await downloadIncomingMedia(msg);
  const form = new FormData();
  form.append('content', msg.content);
  form.append('message_type', msg.messageType || 'incoming');
  form.append('private', 'false');
  form.append('echo_id', msg.echoId);
  form.append('content_attributes', JSON.stringify(compactObject({
    fzap_echo_id: msg.echoId,
    fzap_channel_key: msg.channelKey,
    fzap_synced_from_me: msg.fromMe || undefined,
    fzap_bridge_sync_only: msg.fromMe || undefined
  })));
  form.append('attachments[]', media.blob, media.fileName);

  const result = await evoFetchForm(`/api/v1/conversations/${conversationId}/messages`, form);
  log('info', 'media message created', {
    conversationId,
    messageId: result?.id,
    fileName: media.fileName,
    mimeType: media.mimeType,
    size: media.size
  });
  return result;
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

async function wuzapiFetch(path, channel, body) {
  return wuzapiRequest(path, channel, { method: 'POST', body });
}

function wuzapiHeaders(channel, hasBody = false) {
  const instance = channel.instance || channel.instanceId || channel.wuzapiInstanceId || '';
  return compactObject({
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    token: channel.token,
    ...(instance ? { instance } : {})
  });
}

async function wuzapiRequest(path, channel, options = {}) {
  const method = options.method || 'GET';
  const hasBody = options.body !== undefined;
  const response = await fetch(`${WUZAPI_BASE_URL}${path}`, {
    method,
    headers: wuzapiHeaders(channel, hasBody),
    ...(hasBody ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`Wuzapi ${response.status} ${method} ${path}`);
    err.status = response.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function listWebhookItems(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.webhooks)) return body.webhooks;
  if (Array.isArray(body)) return body;
  return [];
}

function webhookEvents(item) {
  if (Array.isArray(item?.events)) return item.events.map(String);
  if (Array.isArray(item?.Events)) return item.Events.map(String);
  const single = item?.event || item?.Event || item?.type || item?.Type;
  return single ? [String(single)] : [];
}

function sameEventSet(actual, desired) {
  if (actual.length !== desired.length) return false;
  const normalized = actual.map(String).sort().join('|');
  return normalized === desired.map(String).sort().join('|');
}

function bridgeWebhookUrl(channelKey) {
  return `${BRIDGE_PUBLIC_BASE_URL}/fzap/webhook/${encodeURIComponent(channelKey)}?secret=${encodeURIComponent(SECRET)}`;
}

async function ensureWuzapiWebhook(channelKey, channel) {
  if (!SECRET) {
    log('warn', 'wuzapi webhook auto config skipped', { channelKey, reason: 'missing_secret' });
    return;
  }
  if (!channel?.token) {
    log('warn', 'wuzapi webhook auto config skipped', { channelKey, reason: 'missing_token' });
    return;
  }

  const url = bridgeWebhookUrl(channelKey);
  const desiredEventSets = [['All'], ['AutomationMessage']];
  const existingBody = await wuzapiRequest('/webhook', channel, { method: 'GET' });
  const existing = listWebhookItems(existingBody);
  const ours = existing.filter((item) => {
    const itemUrl = item?.url || item?.webhookUrl || item?.WebhookUrl || '';
    return typeof itemUrl === 'string' && itemUrl === url;
  });

  for (const desiredEvents of desiredEventSets) {
    const match = ours.find((item) => sameEventSet(webhookEvents(item), desiredEvents));
    const payload = { url, webhookUrl: url, events: desiredEvents };
    if (match?.id) {
      await wuzapiRequest(`/webhook/${match.id}`, channel, { method: 'PUT', body: payload });
      log('info', 'wuzapi webhook updated', { channelKey, events: desiredEvents });
    } else {
      await wuzapiRequest('/webhook', channel, { method: 'POST', body: payload });
      log('info', 'wuzapi webhook created', { channelKey, events: desiredEvents });
    }
  }
}

async function ensureAllWuzapiWebhooks() {
  const entries = Object.entries(CHANNELS);
  if (!entries.length) return;
  for (const [channelKey, channel] of entries) {
    try {
      await ensureWuzapiWebhook(channelKey, channel);
    } catch (err) {
      log('warn', 'wuzapi webhook auto config failed', {
        channelKey,
        status: err.status,
        body: err.body,
        error: err.message
      });
    }
  }
}

async function sendTextToWuzapi(channel, phone, content, id) {
  if (!content) return { ignored: 'empty_text' };
  markBridgeOutboundId(id);
  const response = await wuzapiFetch('/chat/send/text', channel, {
    phone,
    body: content,
    id,
    check: true,
    linkPreview: true
  });
  return { type: 'text', response };
}

async function sendLocationToWuzapi(channel, phone, location, id) {
  markBridgeOutboundId(id);
  const response = await wuzapiFetch('/chat/send/location', channel, compactObject({
    phone,
    id,
    latitude: location.latitude,
    longitude: location.longitude,
    name: location.name,
    address: location.address,
    url: location.url,
    check: true
  }));
  return { type: 'location', response };
}

async function sendContactToWuzapi(channel, phone, contact, id) {
  markBridgeOutboundId(id);
  const response = await wuzapiFetch('/chat/send/contact', channel, {
    phone,
    id,
    name: contact.name,
    vcard: contact.vcard,
    check: true
  });
  return { type: 'contact', response };
}

async function sendAttachmentToWuzapi(channel, phone, attachment, caption = '', id = '') {
  const url = attachmentUrl(attachment);
  if (!url) return { ignored: 'attachment_no_url', attachment: summarizePayload(attachment) };
  markBridgeOutboundId(id);

  const type = attachmentType(attachment);
  const fileName = attachmentName(attachment, url);
  const mimeType = attachmentMime(attachment);
  const base = compactObject({
    phone,
    caption,
    fileName,
    mimeType,
    id,
    check: true
  });

  if (type === 'image') {
    const response = await wuzapiFetch('/chat/send/image', channel, { ...base, image: url });
    return { type, fileName, response };
  }
  if (type === 'audio') {
    const response = await wuzapiFetch('/chat/send/audio', channel, {
      ...base,
      audio: url,
      ptt: mimeType.includes('ogg') || mimeType.includes('opus')
    });
    return { type, fileName, response };
  }
  if (type === 'video') {
    const response = await wuzapiFetch('/chat/send/video', channel, { ...base, video: url });
    return { type, fileName, response };
  }
  if (type === 'sticker') {
    const response = await wuzapiFetch('/chat/send/sticker', channel, compactObject({
      phone,
      id,
      sticker: url,
      mimeType: mimeType || 'image/webp',
      check: true
    }));
    return { type, fileName, response };
  }

  const response = await wuzapiFetch('/chat/send/document', channel, { ...base, document: url });
  return { type: 'document', fileName, response };
}

async function sendToWuzapi(payload) {
  if (payload.event !== 'message_created') {
    log('info', 'outgoing ignored', { reason: 'event', event: payload.event });
    return { ignored: 'event' };
  }
  if (isBridgeSyncedOutgoing(payload)) {
    log('info', 'outgoing ignored', { reason: 'bridge_sync_only', messageId: payload.id });
    return { ignored: 'bridge_sync_only' };
  }
  if (!isOutgoingMessage(payload)) {
    log('info', 'outgoing ignored', {
      reason: 'message_type',
      messageType: payload.message_type,
      senderType: payload.sender?.type || payload.sender_type
    });
    return { ignored: 'message_type' };
  }
  if (payload.private) {
    log('info', 'outgoing ignored', { reason: 'private', messageType: payload.message_type });
    return { ignored: 'private' };
  }

  const sourceId = payload?.conversation?.contact_inbox?.source_id || payload.source_id || '';
  const channelKey = payload?.conversation?.custom_attributes?.fzap_channel_key || channelFromSource(sourceId);
  const channel = CHANNELS[channelKey];
  if (!channel?.token) throw new Error(`missing channel token for ${channelKey || 'unknown'}`);

  const phone = phoneFromSource(sourceId, payload.sender || payload?.conversation?.meta?.sender);
  if (!phone) throw new Error('missing destination phone');

  const content = normalizeOutgoingContent(payload.content);
  const location = outgoingLocation(payload);
  const contact = outgoingContact(payload);
  const attachments = outgoingAttachments(payload);
  const baseWuzapiId = outgoingWuzapiId(payload);
  const results = [];

  if (location) results.push(await sendLocationToWuzapi(channel, phone, location, baseWuzapiId));
  if (contact) results.push(await sendContactToWuzapi(channel, phone, contact, baseWuzapiId));

  if (attachments.length) {
    for (const [index, attachment] of attachments.entries()) {
      results.push(await sendAttachmentToWuzapi(channel, phone, attachment, index === 0 ? content : '', `${baseWuzapiId}${index}`));
    }
  } else if (!location && !contact && content) {
    results.push(await sendTextToWuzapi(channel, phone, content, baseWuzapiId));
  }

  if (!results.length) return { ignored: 'empty_content' };
  return { sent: true, channel: channel.label || channelKey, phone, results };
}

async function handleIncoming(req, res, channelKey) {
  const payload = await readBody(req);
  const msg = await parseIncoming(payload, channelKey);
  if (msg.ignore) {
    log('info', 'incoming ignored', { channelKey, reason: msg.reason, ...(msg.debug || {}) });
    return sendJson(res, 200, { ok: true, ignored: msg.reason });
  }
  const dedupe = markIncomingMessage(msg);
  if (dedupe.duplicate) {
    log('info', 'incoming duplicate ignored', { channelKey, echoId: msg.echoId, dedupeKey: dedupe.key });
    return sendJson(res, 200, { ok: true, ignored: 'duplicate' });
  }

  try {
    const inboxId = await resolveInboxId();
    const contactCtx = await ensureContact(msg, inboxId);
    const conversationId = await getOrCreateConversation(msg, contactCtx, inboxId);
    await addIncomingMessage(msg, conversationId);
    log('info', 'incoming synced', {
      channelKey,
      phone: msg.phone,
      conversationId,
      contactId: contactCtx.contactId,
      media: Boolean(msg.mediaUrl),
      fromMe: Boolean(msg.fromMe),
      eventName: msg.eventName,
      messageType: msg.messageType
    });
    sendJson(res, 200, { ok: true, conversationId });
  } catch (err) {
    if (dedupe.key) recentIncomingMessages.delete(dedupe.key);
    throw err;
  }
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
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        channels: Object.keys(CHANNELS),
        webhookSyncIntervalMs: WUZAPI_WEBHOOK_SYNC_INTERVAL_MS
      });
    }
    if (SECRET && url.searchParams.get('secret') !== SECRET) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/fzap/debug') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        channels: Object.keys(CHANNELS),
        recent: recentDiagnostics.slice(-80)
      });
    }

    const incomingMatch = url.pathname.match(/^\/fzap\/webhook\/([^/]+)$/);
    if (req.method === 'POST' && incomingMatch) return await handleIncoming(req, res, incomingMatch[1]);
    if (req.method === 'POST' && url.pathname === '/fzap/outgoing') return await handleOutgoing(req, res);

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log('error', err.message, { status: err.status, body: err.body, stack: err.stack });
    sendJson(res, 500, { ok: false, error: err.message, details: err.body });
  }
});

server.listen(PORT, () => {
  log('info', 'fzap evo bridge listening', { port: PORT, version: VERSION });
  ensureAllWuzapiWebhooks().catch((err) => {
    log('warn', 'wuzapi webhook auto config failed', { error: err.message, stack: err.stack });
  });
  if (WUZAPI_WEBHOOK_SYNC_INTERVAL_MS > 0) {
    setInterval(() => {
      ensureAllWuzapiWebhooks().catch((err) => {
        log('warn', 'wuzapi webhook periodic sync failed', { error: err.message, stack: err.stack });
      });
    }, WUZAPI_WEBHOOK_SYNC_INTERVAL_MS).unref();
  }
});
