'use strict';

const crypto = require('node:crypto');

function encryptionKey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('PLATFORM_CONNECTION_ENCRYPTION_KEY es obligatoria.');
  }
  const source = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(source)
    ? Buffer.from(source, 'hex')
    : Buffer.from(source, 'base64');
  if (key.length !== 32) {
    throw new Error('PLATFORM_CONNECTION_ENCRYPTION_KEY debe contener 32 bytes.');
  }
  return key;
}

function createSecretBox(value) {
  const key = encryptionKey(value);
  return Object.freeze({
    seal(plainText) {
      if (typeof plainText !== 'string' || !plainText) throw new Error('Secreto vacío.');
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url')].join('.');
    },
    open(envelope) {
      const [version, nonce, tag, encrypted, extra] = String(envelope || '').split('.');
      if (version !== 'v1' || !nonce || !tag || !encrypted || extra) {
        throw new Error('Secreto cifrado inválido.');
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  });
}

module.exports = { createSecretBox };
