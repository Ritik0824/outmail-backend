import crypto from 'crypto';

const CURRENT_VERSION = 'v2';
const CURRENT_ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc';

function currentKey() {
  return crypto.createHash('sha256').update(String(process.env.SECRET_KEY)).digest();
}

function legacyKey() {
  return Buffer.from(
    crypto.createHash('sha256')
      .update(String(process.env.SECRET_KEY))
      .digest('base64')
      .substring(0, 32),
  );
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CURRENT_ALGORITHM, currentKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return [CURRENT_VERSION, iv.toString('hex'), authTag.toString('hex'), encrypted].join(':');
}

export function decrypt(encryptedText) {
  if (encryptedText.startsWith(`${CURRENT_VERSION}:`)) {
    const [version, ivHex, authTagHex, encrypted] = encryptedText.split(':');
    if (version !== CURRENT_VERSION || !ivHex || !authTagHex || encrypted === undefined) {
      throw new Error('Invalid encrypted credential');
    }
    const decipher = crypto.createDecipheriv(
      CURRENT_ALGORITHM,
      currentKey(),
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  const [ivHex, encrypted] = encryptedText.split(':');
  if (!ivHex || encrypted === undefined) {
    throw new Error('Invalid encrypted credential');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, legacyKey(), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
