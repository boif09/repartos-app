import crypto from 'node:crypto';
import { formatMoney } from '../shared/money.js';

// Avisos push sin dependencias: cifrado del mensaje (RFC 8291, aes128gcm) e identificación del
// servidor con VAPID (RFC 8292). Las claves VAPID se generan una vez y se guardan en app_settings.

const b64url = (value) => Buffer.from(value).toString('base64url');

// Solo se envían avisos a los servicios push de los navegadores (evita usar el servidor para
// hacer peticiones a direcciones arbitrarias). Chrome/Android, Firefox, Safari/iOS y Edge.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

export function isPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

// Cifra payload para una suscripción. salt y senderKey solo se pasan en los tests (vector del RFC).
export function encryptPayload(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), senderPrivateKey } = {}) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (senderPrivateKey) ecdh.setPrivateKey(senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // Un solo registro: el mensaje + delimitador 0x02 (último registro), sin relleno.
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

// Texto del aviso para quien lo recibe: qué ha pasado y cuánto le toca.
export function describeForRecipient(event, recipientId, groupTitle) {
  const data = event.data ?? {};
  const actor = data.actorName ?? 'Alguien';
  const money = (cents) => formatMoney(cents, data.currency ?? 'EUR');
  const myShare = data.shares?.find((share) => share.personId === recipientId)?.owedCents ?? 0;
  const share = myShare ? ` · te toca ${money(myShare)}` : '';
  const amount = data.originalCurrency && data.originalCurrency !== data.currency
    ? formatMoney(data.originalMinor, data.originalCurrency)
    : money(data.amountCents ?? 0);
  let body;
  switch (event.kind) {
    case 'expense_created': body = data.recurring
      ? `Gasto recurrente «${data.description}»: ${amount}${share}`
      : `${actor} añadió «${data.description}»: ${amount}${share}`; break;
    case 'expense_updated': body = `${actor} editó «${data.description}»: ${amount}${share}`; break;
    case 'expense_deleted': body = `${actor} borró «${data.description}» (${amount})`; break;
    case 'settlement_created': {
      const who = data.toId === recipientId ? `${data.fromName} te pagó` : data.fromId === recipientId ? `Pagaste a ${data.toName}` : `${data.fromName} pagó a ${data.toName}`;
      body = `${who} ${money(data.amountCents)}${data.fromId === recipientId ? ` (lo apuntó ${actor})` : ''}`;
      break;
    }
    default: return null;
  }
  return { title: groupTitle, body, url: `./#/g/${event.groupId}`, tag: `grupo-${event.groupId}` };
}

export function createPushService(repo, {
  fetchImpl = globalThis.fetch,
  subject = process.env.PUSH_SUBJECT || 'https://repartos.jusboif.es',
  now = () => Date.now(),
  logger = console,
} = {}) {
  let keys = null;

  function vapidKeys() {
    if (keys) return keys;
    let stored = repo.getSetting('vapid_private_jwk');
    if (!stored) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      stored = JSON.stringify(privateKey.export({ format: 'jwk' }));
      repo.setSetting('vapid_private_jwk', stored);
    }
    const jwk = JSON.parse(stored);
    keys = {
      privateKey: crypto.createPrivateKey({ key: jwk, format: 'jwk' }),
      publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
    };
    return keys;
  }

  function authorization(endpoint) {
    const { privateKey, publicKey } = vapidKeys();
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub: subject }));
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
  }

  async function send(subscription, message) {
    if (!isPushEndpoint(subscription.endpoint)) return;
    try {
      const response = await fetchImpl(subscription.endpoint, {
        method: 'POST',
        headers: {
          Authorization: authorization(subscription.endpoint),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: 'normal',
        },
        body: encryptPayload(JSON.stringify(message), subscription),
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      // 404/410: el móvil ya no tiene esa suscripción (app desinstalada, permiso retirado…).
      if (response.status === 404 || response.status === 410) repo.forgetPushEndpoint(subscription.endpoint);
      else if (!response.ok) logger.warn(`Aviso push rechazado (${response.status}) por ${new URL(subscription.endpoint).host}`);
    } catch (error) {
      logger.warn(`No se pudo enviar un aviso push: ${error.message}`);
    }
  }

  // Se llama tras cada cambio confirmado. No bloquea la respuesta a quien hizo el cambio.
  function notify(event) {
    const targets = repo.pushTargets(event.groupId, event.actorId);
    if (!targets.length) return Promise.resolve();
    const group = repo.groupTitle(event.groupId);
    const actorName = event.actorId ? repo.personName?.(event.actorId) : null;
    const enriched = { ...event, data: { ...event.data, actorName: event.data.actorName ?? actorName } };
    return Promise.all(targets.map((target) => {
      const message = describeForRecipient(enriched, target.person_id, group?.title ?? 'Repartos');
      return message ? send(target, message) : null;
    }));
  }

  return { publicKey: () => vapidKeys().publicKey, notify, authorization };
}
