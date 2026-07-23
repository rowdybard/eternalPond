const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function timingSafeStringEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function encryptionKeyBytes(base64Key: string): Uint8Array {
  const bytes = base64ToBytes(base64Key);
  if (bytes.byteLength !== 32) throw new Error("EMAIL_ENCRYPTION_KEY must decode to 32 bytes");
  return bytes;
}

async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encryptionKeyBytes(base64Key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function importEmailHashKey(base64Key: string): Promise<CryptoKey> {
  const source = encryptionKeyBytes(base64Key);
  const material = new Uint8Array(encoder.encode("eternal-pond:email-hash:v1").byteLength + source.byteLength);
  material.set(encoder.encode("eternal-pond:email-hash:v1"), 0);
  material.set(source, material.byteLength - source.byteLength);
  const derived = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export interface EncryptedText {
  ciphertext: string;
  iv: string;
  version: 1;
}

export async function encryptText(value: string, base64Key: string): Promise<EncryptedText> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importEncryptionKey(base64Key);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv), version: 1 };
}

export async function decryptText(value: EncryptedText, base64Key: string): Promise<string> {
  if (value.version !== 1) throw new Error("Unsupported encrypted text version");
  const key = await importEncryptionKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(value.iv) },
    key,
    base64ToBytes(value.ciphertext),
  );
  return decoder.decode(plaintext);
}

export function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return null;
  return normalized;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.length <= 1 ? local : local.slice(0, Math.min(2, local.length));
  return `${visible}${local.length > visible.length ? "…" : ""}@${domain}`;
}

export async function keyedEmailHash(email: string, base64Key: string): Promise<string> {
  const key = await importEmailHashKey(base64Key);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(email))));
}

