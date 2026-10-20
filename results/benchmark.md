# Số liệu thực nghiệm trước / sau

Chạy lúc 2026-10-20T03:12:42.712Z, Node v24.21.0, win32.

Baseline dùng cùng mã nghiệp vụ, tắt keep-alive, chỉ 1 lần gọi, timeout 10 s/lần (ngân sách 12 s). Bản sau dùng cấu hình mặc định: keep-alive, tối đa 10 socket, 5 lần gọi, ngân sách chung 4 s. Đây là so sánh cấu hình tái lập, không phải số liệu từ một phiên bản cũ chưa có trong thư mục.

| Phép đo | Trước | Sau |
|---|---:|---:|
| 1 — Ngân hàng tắt: HTTP / thời gian | 503 / 16.7 ms | 503 / 621.3 ms |
| 1 — GET công nợ lúc ngân hàng tắt | 200 / 2 ms | 200 / 1 ms |
| 1 — Ngân hàng bật lại, giữ nguyên Fee Service | 201 | 201 |
| 2 — Một thanh toán, DELAY_MS=5000 | 201 PAID / 5003.2 ms | 504 PENDING / 4005.2 ms |
| 2 — 20 đồng thời: PAID / PENDING | 10 / 10 | 0 / 20 |
| 2 — Thời gian thanh toán lớn nhất | 10028.1 ms | 4015.1 ms |
| 2 — GET công nợ trong lúc chờ | 1.8 ms | 1.2 ms |
| 3 — Thành công / tổng thời gian (200, đồng thời 10) | 200/200 / 286.7 ms | 200/200 / 167.3 ms |
| 3 — Kết nối TCP ngân hàng | 201 | 11 |
| 3 — Thành công sau nhàn rỗi 6 s | 5/5 | 5/5 |
| 4a — DROP_RATE=0.3: PAID / PENDING / charges / duplicates | 45 / 15 / 60 / 0 | 60 / 0 / 60 / 0 |
| 4a — Công nợ còn lại | 49955000 | 49940000 |
| 4b — FAIL_RATE=0.3: PAID / FAILED / charges / duplicates | 40 / 20 / 40 / 0 | 60 / 0 / 60 / 0 |
| 4c — 25.000.000đ: HTTP / số request ngân hàng | 402 / 1 | 402 / 1 |

Mỗi phép đo dùng dữ liệu bộ nhớ mới; tiền thanh toán là 1.000đ, trừ ca từ chối. Số TCP tính cả kết nối đọc `/stats` (thường thêm 1). Seed cố định 20261020 để tái lập lỗi; service chạy thật dùng Math.random. Thời gian phụ thuộc máy. `requests` chỉ đếm POST /charges; replay vẫn tính request nhưng không thêm charge.

PENDING giữ nguyên công nợ và giữ chỗ số tiền chờ xác nhận. Ngân hàng có thể hoàn tất sau khi client timeout; công nợ chỉ giảm khi retry cùng payment nhận được xác nhận.
