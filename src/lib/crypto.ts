import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** argon2id, cấu hình theo khuyến nghị OWASP (19 MiB, 2 vòng). PIN ngắn nên dựa thêm vào giới hạn thử đăng nhập. */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPin = (pin: string) => hash(pin, ARGON2);

export async function verifyPin(pinHash: string, pin: string): Promise<boolean> {
  try {
    return await verify(pinHash, pin);
  } catch {
    return false;
  }
}

export const newToken = () => randomBytes(32).toString('base64url');

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

let dummyHash: Promise<string> | undefined;
/** Băm giả để thời gian phản hồi như nhau khi email không tồn tại (tránh dò tài khoản). */
export const getDummyHash = () => (dummyHash ??= hashPin('000000'));
