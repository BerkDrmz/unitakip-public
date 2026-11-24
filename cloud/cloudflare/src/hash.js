import CryptoJS from 'crypto-js';
export const hash = (value) => CryptoJS.SHA256(typeof value === 'string' ? value : JSON.stringify(value)).toString();
