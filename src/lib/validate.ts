import type { Context } from 'hono';
import type { z } from 'zod';
import { errors } from '../errors.js';

function fieldsOf(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/** Đọc và kiểm tra JSON gửi lên; sai → lỗi 400 `VALIDATION` kèm lỗi theo từng trường. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw errors.validation({ _: 'Nội dung gửi lên không phải JSON hợp lệ.' });
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw errors.validation(fieldsOf(result.error));
  return result.data;
}
