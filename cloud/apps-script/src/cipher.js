import CryptoJS from 'crypto-js';

const word = (bytes) => CryptoJS.lib.WordArray.create(Uint8Array.from(bytes));
const bytes = (value) => Array.from({ length: value.sigBytes }, (_, i) => (value.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255);
const decode = (value) => bytes(CryptoJS.enc.Base64.parse(value.replace(/-/g, '+').replace(/_/g, '/')));
const encode = (value) => word(value).toString(CryptoJS.enc.Base64).replace(/\+/g, '-').replace(/\//g, '_');

/** Fernet envelope compatible with cryptography.Fernet; nonce is supplied by the host. */
export class Cipher {
  constructor(key) {
    const raw = decode(key);
    if (raw.length !== 32) throw new Error('Bulut şifreleme anahtarı geçersiz.');
    this.signing = word(raw.slice(0, 16));
    this.encryption = word(raw.slice(16));
  }

  seal(text, nonce, now = Date.now()) {
    if (!nonce) throw new Error('Şifreleme için benzersiz nonce gerekli.');
    // A secret-key PRF makes the unique host nonce an unpredictable CBC IV.
    const iv = bytes(CryptoJS.HmacSHA256(`unitakip-iv/${nonce}`, this.signing)).slice(0, 16);
    const timestamp = Math.floor(now / 1000);
    const high = Math.floor(timestamp / 2 ** 32);
    const low = timestamp >>> 0;
    const stamp = [high >>> 24, high >>> 16, high >>> 8, high, low >>> 24, low >>> 16, low >>> 8, low].map((n) => n & 255);
    const encrypted = CryptoJS.AES.encrypt(text, this.encryption, { iv: word(iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    const body = [128, ...stamp, ...iv, ...bytes(encrypted.ciphertext)];
    return encode([...body, ...bytes(CryptoJS.HmacSHA256(word(body), this.signing))]);
  }

  open(token) {
    try {
      const raw = decode(token);
      if (raw.length < 73 || raw[0] !== 128 || (raw.length - 57) % 16 !== 0) throw new Error();
      const body = raw.slice(0, -32);
      const expected = bytes(CryptoJS.HmacSHA256(word(body), this.signing));
      let mismatch = 0;
      for (let i = 0; i < 32; i++) mismatch |= expected[i] ^ raw[raw.length - 32 + i];
      if (mismatch) throw new Error();
      const result = CryptoJS.AES.decrypt({ ciphertext: word(raw.slice(25, -32)) }, this.encryption, {
        iv: word(raw.slice(9, 25)), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
      });
      return result.toString(CryptoJS.enc.Utf8);
    } catch {
      throw new Error('Şifreli bulut verisi doğrulanamadı; mevcut durum sıfırlanmadı.');
    }
  }
}

export const hash = (value) => CryptoJS.SHA256(typeof value === 'string' ? value : JSON.stringify(value)).toString();
