/** Lỗi nghiệp vụ có mã ổn định; trả về dạng `{ error: { code, message, fields? } }`. */
export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const errors = {
  validation: (fields: Record<string, string>) => new AppError(400, 'VALIDATION', 'Dữ liệu chưa hợp lệ.', fields),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Bạn chưa đăng nhập hoặc phiên đã hết hạn.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này.'),
  notFound: (what = 'Dữ liệu') => new AppError(404, 'NOT_FOUND', `${what} không tồn tại.`),
};
