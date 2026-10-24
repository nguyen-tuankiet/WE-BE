export type Row = object;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Chạy nhiều câu lệnh một lúc (dùng cho migration), không có tham số. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Chạy `fn` trong một giao dịch: lỗi bất kỳ → hoàn tác toàn bộ. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
