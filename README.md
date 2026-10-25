# Backend — WE Kết nối quốc tế

Node.js 22 + TypeScript + Hono, PostgreSQL (Neon). Triển khai **độc lập** với `../frontend`.
Kế hoạch & mô hình dữ liệu: `../.claude/docs/10-ke-hoach-backend.md`.

**Trạng thái: xong M0–M5 (nền, danh mục & hồ sơ, điểm danh, học bù/bảo lưu/chuyển lớp, học vụ, vận hành: Tổng quan, nhắc việc, CAP, nhập/xuất) và đã nối với giao diện.** Chạy thử ngay không cần DB: `npm run dev:demo` (xem mục 2b). M0: đăng nhập email + PIN (argon2id), phiên cookie, vai trò, quản lý nhân sự, giới hạn thử đăng nhập, nhật ký, migration, kiểm tra tương thích DB. M1: danh mục 46 gói, ca/phòng, cài đặt, học viên, lớp, khóa đăng ký (sinh sẵn lịch buổi học), ngày nghỉ dời lịch. M2: sổ ngày/tháng, ghi hàng loạt, quyền theo lớp và cửa sổ sửa của giáo viên. M3: học bù (đề xuất, định mức theo nhóm, vòng đời), bảo lưu & nhập học lại, chuyển lớp giữa khóa. Tiếp theo M4: học vụ (kiểm tra nhiều Unit).

## 1. Chuẩn bị cơ sở dữ liệu (Neon, miễn phí)
1. Tạo tài khoản tại neon.com, tạo một project, chọn khu vực **Singapore**.
2. Vào **Connect** → sao chép chuỗi kết nối (dạng `postgresql://…?sslmode=require`).
3. Chép `.env.example` thành `.env` và dán chuỗi vào `DATABASE_URL`. **Không commit `.env`, không gửi chuỗi này cho ai/vào khung chat** (có mật khẩu).

## 2. Chạy trên máy
```bash
npm install
npm run migrate          # tạo bảng trong DB (chỉ chạy các migration chưa áp dụng)
npm run seed             # nạp 46 gói, ca học, phòng, cài đặt mặc định (chạy lặp được, không ghi đè)
npm run check-compat     # kiểm tra DB hỗ trợ các tính năng thiết kế dựa vào (nên đạt 18/18)
npm run dev              # http://localhost:3000  (GET /health để kiểm tra)
```

## 2b. Chạy thử không cần Neon (dữ liệu giả)
```bash
npm run dev:demo         # API tại http://127.0.0.1:8787, PostgreSQL nhúng trong bộ nhớ, "hôm nay" = 2026-10-22
```
Tắt là mất dữ liệu; **không dùng cho dữ liệu thật**. Tài khoản (PIN `123456`): `admin@we.vn`, `quanly@we.vn`, `gv.lan@we.vn`, `gv.minh@we.vn`, `thanhtra@we.vn`.
Giao diện nối vào: trong `../frontend` chạy `npm run dev -- --mode real --host 127.0.0.1 --port 5174` (đọc `frontend/.env.real`: `VITE_API_MODE=real`, `VITE_API_URL=http://127.0.0.1:8787`). Mở bằng **127.0.0.1** (không phải localhost) để cookie phiên cùng "site" với API.

## 3. Tạo Admin đầu tiên
Đặt `BOOTSTRAP_SECRET` (≥ 16 ký tự) trong `.env`, khởi động server rồi gọi **một lần**:
```bash
curl -X POST http://localhost:3000/api/v1/auth/bootstrap -H "Content-Type: application/json" \
  -d '{"secret":"<BOOTSTRAP_SECRET>","email":"admin@we.vn","name":"Quản trị","pin":"123456"}'
```
Sau đó **xóa `BOOTSTRAP_SECRET`** khỏi `.env` (chỉ chạy được khi hệ thống chưa có tài khoản nào). Đổi PIN ngay khi dùng thật.

## 4. API hiện có (`/api/v1`)
| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| POST | `/auth/bootstrap` | mã khởi tạo | Tạo Admin đầu tiên |
| POST | `/auth/login` | — | Đăng nhập (đặt cookie `we_session`, HttpOnly) |
| POST | `/auth/logout` | đã đăng nhập | Đăng xuất, thu hồi phiên |
| GET | `/me` | đã đăng nhập | Thông tin + vai trò |
| GET/POST | `/staff` | Admin | Danh sách / tạo nhân sự |
| PATCH | `/staff/:id` | Admin | Sửa tên, vai trò, PIN, khóa/mở (khóa hoặc đổi PIN thu hồi mọi phiên) |
| GET | `/reference` | đăng nhập | Ca học, phòng |
| GET / PATCH | `/programs`, `/programs/:id` | đọc: đăng nhập · sửa: Admin/Manager | 46 gói chương trình (sửa không ghi đè khóa đã đăng ký) |
| GET / PUT | `/settings` | đọc: đăng nhập · sửa: Admin/Manager | Cài đặt (nhắc việc, cửa sổ sửa điểm danh của giáo viên, ngưỡng mặc định) |
| GET / POST / DELETE | `/holidays`, `/holidays/:date` | đọc: đăng nhập · ghi: Admin/Manager | Ngày nghỉ trung tâm — thêm/xóa tự dời lịch buổi chính, vẫn đủ định mức; không dời buổi đã điểm danh, ngày đã có điểm danh không thành ngày nghỉ được |
| GET / POST | `/students` | đăng nhập · tạo: Admin/Manager | Danh sách (giáo viên chỉ thấy học viên lớp mình; liên hệ/học phí chỉ Admin/Manager) |
| GET | `/students/:id` | đăng nhập (giáo viên: lớp mình) | Hồ sơ + các khóa đăng ký + tiến độ |
| PATCH | `/students/:id`, `/students/:id/star` | Admin/Manager · dấu sao: + Thanh tra | Sửa hồ sơ / đặt ngưỡng đánh giá riêng |
| GET / POST / PATCH | `/classes`, `/classes/:id` | đọc: đăng nhập (giáo viên: lớp mình) · ghi: Admin/Manager | Lớp, ngày học, ca, phòng, giáo viên |
| GET / POST | `/enrollments` | Admin/Manager | Khóa đăng ký: chụp học phí + định mức bù, sinh sẵn toàn bộ buổi chính |
| GET | `/attendance/sheet?classId&date` | Admin/Manager/Giáo viên (lớp mình) | Sổ ngày: học viên có buổi ngày đó + kết quả (chưa ghi nhận = `record: null`), cờ `editable`/`lockReason` |
| PUT | `/attendance` | như trên | Ghi hàng loạt trong một giao dịch; ghi lại cùng nội dung không tạo thay đổi; có nhật ký trước/sau |
| GET | `/attendance/ledger?classId&month=YYYY-MM` | như trên | Sổ tháng: mỗi ô một buổi (`present`/`late`/`absent`/`none`/`future`/`off`) |
| GET | `/makeups` | Admin/Manager · giáo viên (lớp mình) | Lượt bù + **đề xuất** (buổi vắng đã báo nghỉ, còn trong định mức) |
| POST | `/makeups` | Admin/Manager | Xếp bù: chặn nghỉ không báo, vượt định mức, trùng ngày/ngày nghỉ, sai quy tắc ngày (30′ gắn vào các buổi chính cuối; 90′ sau ngày kết thúc) |
| PATCH | `/makeups/:id` | Admin/Manager | `done` (Hoàn tất) / `missed` (Vắng bù — vẫn mất lượt) / `cancelled` (cần lý do) |
| GET / POST | `/reserves` | Admin/Manager | Danh sách (tự đánh dấu hết hạn) / tạo bảo lưu theo chính sách |
| POST | `/reserves/:id/return` | Admin/Manager | Nhập học lại: xếp lớp, tiếp tục số buổi còn lại |
| POST | `/enrollments/:id/transfer` | Admin/Manager | Chuyển lớp giữa khóa, giữ lịch sử lớp cũ và quyền học còn lại |
| GET/POST/PATCH | `/academics/units`, `/academics/units/:id`, `/academics/criteria` | Admin/Manager/Thanh tra | Khung nội dung Unit theo mẫu phiếu (baby/foundation/cambridge) |
| GET/POST | `/exams`, `/exams/plans`, `/exams/plans/:id` | Admin/Manager/Thanh tra | Lịch kiểm tra nhiều Unit |
| PUT | `/exams/plans/:id/result` | như trên | Chấm đủ mọi Unit; lưu kết quả + hoàn tất lịch trong một giao dịch; chụp nội dung Unit và ngưỡng lúc chấm |
| GET | `/reports/students`, `/reports/students/:id` | như trên | Báo cáo học tập theo học viên |
| GET | `/dashboard?from&to`, `/dashboard/charts` | đăng nhập (chỉ số quản lý: Admin/Manager; giáo viên: buổi lớp mình) | Tổng quan theo khoảng ngày |
| GET | `/dashboard/detail/{attendance,group,ending,rating}` | Admin/Manager (rating: + Thanh tra) | Danh sách khi bấm vào biểu đồ |
| GET/PUT | `/tasks`, `/tasks/:key` | đăng nhập | Việc cần quan tâm (tự suy ra từ dữ liệu) + đánh dấu đã xử lý (lưu người, thời điểm) |
| GET/POST/DELETE | `/cap` | Admin/Manager | Lịch CAP: chặn trùng phòng/giáo viên, lệch ngày học |
| GET | `/export/students.csv` | Admin/Manager | CSV UTF-8 có BOM |
| POST | `/import/students` `{csv｜rows, dryRun}` | Admin/Manager | Nhập có đối chiếu: trùng (họ tên + ngày sinh) và dòng lỗi được báo, nhập lặp không nhân đôi |
| GET | `/teachers` | Admin/Manager | Giáo viên đang hoạt động để chọn khi xếp lớp |
| PATCH | `/enrollments/:id` | Admin/Manager | Sửa khóa: đã nhận học phí, học phí, ghi chú, tổng số buổi, ngày bắt đầu (khi chưa điểm danh…), `status: "completed"` kết thúc khóa. Lỗi: `TOTAL_BELOW_HELD`, `START_LOCKED`, `HAS_SCHEDULED_MAKEUPS`, `ENROLLMENT_NOT_ACTIVE` |
| GET | `/ping` (không có tiền tố) | — | Chỉ báo còn sống, không đụng DB — dùng cho dịch vụ ping giữ Render thức |
| GET | `/health` (không có tiền tố) | — | Kiểm tra server + DB, kèm `today` (ngày theo giờ Việt Nam) |

Lỗi trả dạng `{ "error": { "code", "message", "fields?" } }` với mã ổn định (`VALIDATION`, `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_CREDENTIALS`, `TOO_MANY_ATTEMPTS`, `ACCOUNT_DISABLED`, `EMAIL_EXISTS`, `CANNOT_LOCK_SELF`, `ALREADY_BOOTSTRAPPED`, `BAD_ORIGIN`, `SESSIONS_REQUIRED`, `CLASS_FULL`, `STUDENT_LEFT`, `NO_WEEKDAYS`, `HOLIDAY_EXISTS`, `HOLIDAY_HAS_ATTENDANCE`, `FORBIDDEN_CLASS`, `EDIT_WINDOW_EXPIRED`, `FUTURE_DATE`, `OUT_OF_SCHEDULE`, `MAKEUP_LIMIT_EXCEEDED`, `MAKEUP_NOT_NOTIFIED`, `MAKEUP_EXISTS`, `MAKEUP_DATE_INVALID`, `MAKEUP_DATE_TAKEN`, `MAKEUP_NOT_YET`, `NO_MAKEUP_POLICY`, `RESERVE_ALREADY_USED`, `RESERVE_NOTICE_TOO_SHORT`, `RESERVE_STREAK_TOO_SHORT`, `RESERVE_EXPIRED`, `TRANSFER_IN_PAST`, `SAME_CLASS`, `ENROLLMENT_NOT_ACTIVE`).

## 5. Biến môi trường
Xem `.env.example`. Quan trọng khi deploy: `DATABASE_URL`, `NODE_ENV=production`, `CORS_ORIGIN` (địa chỉ giao diện), và nếu giao diện khác miền với API thì `COOKIE_SAMESITE=None` (bắt buộc HTTPS).

## 6. Kiểm thử và build
```bash
npm test                 # Vitest, chạy trên PostgreSQL nhúng (PGlite) — không cần DB thật
npm run typecheck
npm run build            # ra dist/, chạy bằng: npm start
```

## 7. Sao lưu (quan trọng)
Gói Free của Neon chỉ khôi phục được trong 6 giờ gần nhất. Hãy sao lưu định kỳ bằng `pg_dump` (cần cài PostgreSQL client):
```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom --file=backup-$(date +%F).dump
```
Thử khôi phục (`pg_restore`) vào một DB trống **trước khi** đưa dữ liệu thật vào.

## 8. Cấu trúc
```
migrations/   SQL chỉ-thêm (0001_auth, 0002_core, 0003_attendance, 0004_makeup_reserve_transfer …), chạy bằng npm run migrate
src/          app.ts (Hono) · server.ts · config.ts · errors.ts
  db/         kết nối pg, PGlite (test), migrate, compat (kiểm tra tương thích)
  middleware/ xác thực, vai trò, chặn nguồn lạ
  domain/     lịch buổi học, học bù, danh mục 46 gói (hàm thuần, có test)
  routes/     auth, staff, catalog, students, classes, enrollments, attendance, makeups, reserves, academics, ops
  services/   nghiệp vụ + giao dịch + audit
  seed/       nạp danh mục
scripts/      migrate, seed, check-compat, dev-pglite (máy chủ demo)
test/         Vitest: auth, phân quyền (NT15/NT16), lịch & học bù, hồ sơ + khóa (NT01), điểm danh (NT02, NT15), học bù (NT03–NT07), bảo lưu (NT10), chuyển lớp (NT09), ngày nghỉ (NT08), tương thích DB
```
