/**
 * AES-256-GCM encryption for sensitive data (Plaid tokens, MFA secrets)
 * Uses the ENCRYPTION_KEY from environment variables
 */

import crypto from 'crypto';
import { config } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts a plaintext string using AES-256-GCM
 * Returns a base64-encoded string in format: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Combine iv:authTag:ciphertext
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypts an encrypted string
 * Expects format: iv:authTag:ciphertext (base64 encoded)
 */
export function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();

  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Checks if a string appears to be encrypted (has our format)
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(':');
  return parts.length === 3 && parts.every(p => p.length > 0);
}

/**
 * Gets the encryption key from environment, validates it's 32 bytes
 */
function getEncryptionKey(): Buffer {
  if (!config.encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }

  // If the key is already 32 bytes (hex or base64), use it directly
  // Otherwise, derive a 32-byte key using SHA-256
  const keyBuffer = Buffer.from(config.encryptionKey, 'utf8');

  if (keyBuffer.length === 32) {
    return keyBuffer;
  }

  // Derive a 32-byte key using SHA-256
  return crypto.createHash('sha256').update(config.encryptionKey).digest();
}
