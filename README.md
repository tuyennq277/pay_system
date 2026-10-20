# pay_system

Bài thực hành: thanh toán học phí trực tuyến.

Hai service Node.js/Express, dữ liệu trong bộ nhớ. Yêu cầu Node.js >= 18 và npm; Postman là tùy chọn.

```powershell
npm.cmd install
npm.cmd start
```

Fee Service: `http://localhost:4001`. Ngân hàng giả lập: `http://localhost:4002`. Nhấn Ctrl+C để dừng cả hai. Khi cần bật/tắt ngân hàng riêng, dùng hai cửa sổ terminal:

Mở địa chỉ gốc của mỗi service trong trình duyệt để xem hướng dẫn API. Xem trực tiếp công nợ tại `http://localhost:4001/students/1/fees` và thống kê tại `http://localhost:4002/stats`. Thanh toán yêu cầu **POST** qua Postman hoặc PowerShell; nhập URL trên thanh địa chỉ trình duyệt sẽ gửi **GET**. Các lệnh dưới đây dùng `npm.cmd` để chạy được cả khi PowerShell chặn `npm.ps1`.

```powershell
# Terminal 1
npm.cmd run start:fee
```

```powershell
# Terminal 2
npm.cmd run start:bank
```

## API

| Service | Endpoint | Nội dung |
|---|---|---|
| Fee | `GET /students/1/fees` | `studentId`, `outstanding`, `reserved`, `available`, `currency` |
| Fee | `POST /students/1/payments` | JSON `{"amount":100000}`; sinh P1, P2… |
| Fee | `GET /payments/P1` | Xem trạng thái và số lần gọi ngân hàng |
| Fee | `POST /payments/P1/retry` | Xác nhận lại PENDING bằng chính khóa cũ; PAID không giảm nợ lần nữa |
| Bank | `POST /charges` | JSON `{"reference":"demo-P1","amount":100000}`; header `Idempotency-Key: demo-P1` |
| Bank | `GET /stats` | `connections`, `requests`, `charges`, `duplicates` |

Công nợ ban đầu: sinh viên 1 = **50.000.000đ**; 2 = **0đ**; 3 = **3.200.000đ**. Số tiền phải là số nguyên dương an toàn của JavaScript; số tiền dạng chuỗi bị từ chối. `available = outstanding - reserved`; kiểm tra khả năng thanh toán dựa trên phần còn khả dụng để tránh nhiều yêu cầu đồng thời vượt công nợ.

```powershell
Invoke-RestMethod http://localhost:4001/students/1/fees
Invoke-RestMethod http://localhost:4001/students/1/payments `
  -Method Post -ContentType application/json -Body '{"amount":100000}'
Invoke-RestMethod http://localhost:4002/stats
```

Phản hồi thành công HTTP **201**:

```json
{"paymentId":"P1","studentId":1,"amount":100000,"status":"PAID","chargeId":"C1","attempts":1,"outstanding":49900000}
```

Phản hồi lỗi luôn có `error`, `paymentId`, `status`. Trước khi tạo được lệnh (ví dụ số tiền không hợp lệ), `paymentId` là `null`.

| Kết quả | HTTP | Trạng thái | Công nợ / tiền giữ chỗ |
|---|---:|---|---|
| Ngân hàng xác nhận | 201 | PAID | Giảm công nợ và bỏ giữ chỗ đúng một lần |
| Từ chối rõ ràng | Giữ mã 4xx, ví dụ 402 | FAILED | Không giảm nợ; bỏ giữ chỗ |
| Không kết nối được, hoặc toàn lỗi 500 trước khi trừ | 503 | FAILED | Không giảm nợ; bỏ giữ chỗ |
| Timeout (kể cả chờ socket), reset sau kết nối, phản hồi không thể xác nhận | 504 | PENDING | Không giảm nợ; tiếp tục giữ chỗ |

Một lần gọi mới `POST /students/:id/payments` tạo một lệnh mới. Với lệnh PENDING, dùng `POST /payments/:paymentId/retry` để xác nhận lệnh cũ. Retry đồng thời cùng một lệnh được gộp lại. Lệnh PAID/FAILED là trạng thái cuối; retry lệnh FAILED trả lại lỗi cũ.

## Cấu hình và cách xử lý

Đặt biến môi trường **trong terminal chạy service**, sau đó khởi động lại service đó. `.env.example` chỉ là mẫu; chương trình không tự nạp file `.env`.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `BANK_URL` | `http://localhost:4002` | Địa chỉ ngân hàng mà Fee Service gọi, hỗ trợ HTTP/HTTPS |
| `FEE_PORT` / `BANK_PORT` | `4001` / `4002` | Cổng lắng nghe |
| `DELAY_MS` | `0` | Trễ trước khi xử lý giao dịch mới |
| `FAIL_RATE` | `0` | Xác suất 500 trước khi trừ tiền, trong [0,1] |
| `DROP_RATE` | `0` | Xác suất cắt kết nối sau khi trừ tiền, trong [0,1] |
| `BANK_TIMEOUT_MS` | `4000` | Ngân sách chung cho toàn bộ một lần xử lý, gồm cả retry và backoff |
| `BANK_ATTEMPT_TIMEOUT_MS` | `1200` | Giới hạn mỗi lần gọi, gồm cả thời gian xếp hàng đợi socket |
| `BANK_MAX_ATTEMPTS` | `5` | Tổng số lần gọi tối đa |
| `BANK_MAX_SOCKETS` | `10` | Giới hạn kết nối từ Fee Service tới ngân hàng |
| `BANK_KEEP_ALIVE` | `true` | Bật tái sử dụng TCP; `false` phục vụ so sánh baseline |

Fee Service dùng `http.Agent` / `https.Agent`, tối đa 10 socket, ưu tiên socket nhàn rỗi mới nhất (LIFO). Ngân hàng đóng socket nhàn rỗi sau đúng 5 s và log mỗi kết nối TCP mới. Khi socket đóng hoặc lỗi giữa chừng, Fee Service có thể thử lại trong ngân sách chung. Không sử dụng thao tác chờ đồng bộ, vì vậy GET công nợ vẫn chạy khi các POST đang đợi ngân hàng.

Retry có backoff 50, 100, 200, 250 ms, tối đa 5 lần, luôn dùng cùng `reference` và `Idempotency-Key`. Lỗi 4xx kết thúc ngay. Với simulator này, 500 được bảo đảm xảy ra trước khi trừ tiền. Nếu bất kỳ lần gọi nào đã có kết quả không rõ ràng, lỗi kết nối hoặc 500 ở lần sau không biến lệnh đó thành FAILED.

Bank lưu kết quả thành công theo khóa; cùng khóa và cùng payload trả lại **201 với chargeId cũ**, không chịu lỗi giả lập nữa. Tái dùng khóa với payload khác hoặc reference cũ với khóa khác trả 409. Sau thời gian delay, bank kiểm tra lại khóa ngay trước khi commit để chặn trùng cả khi nhiều request cùng tới. `duplicates` đếm **lần trừ tiền trùng thực tế**, không đếm số request replay. `requests` chỉ đếm POST `/charges`, kể cả replay và request bị từ chối. `connections` đếm mọi TCP tới ngân hàng, kể cả đọc `/stats`.

## Chạy lại bốn tình huống

### 1. Ngân hàng tắt rồi bật lại

Chỉ chạy Fee Service, gọi thanh toán: nhận 503 + FAILED trong < 1,5 s. Gọi GET công nợ để xác nhận Fee Service vẫn sống. Bật ngân hàng ở terminal khác rồi thanh toán lại: nhận 201, không cần khởi động lại Fee Service.

Để kiểm tra địa chỉ khác, dừng Fee Service và chạy:

```powershell
$env:BANK_URL='http://localhost:4999'
npm.cmd run start:fee
```

Khi chưa có ngân hàng ở 4999: 503. Sau đó chạy ngân hàng ở terminal khác:

```powershell
$env:BANK_PORT='4999'
npm.cmd run start:bank
```

### 2. Phản hồi chậm

Khôi phục Fee Service về BANK_URL mặc định nếu vừa làm tình huống 1. Trong terminal ngân hàng:

```powershell
$env:DELAY_MS='5000'
$env:FAIL_RATE='0'
$env:DROP_RATE='0'
npm.cmd run start:bank
```

Thanh toán trả 504 + PENDING trong khoảng 4 s. Ngân hàng vẫn có thể trừ tiền sau khi Fee Service ngừng chờ; công nợ chưa giảm cho tới khi nhận xác nhận. Khi ngân hàng đã xử lý xong, gọi retry lệnh cũ để nhận charge đã lưu. Không tạo lệnh mới để thay cho một lệnh chưa xác nhận.

### 3. Duy trì kết nối

Chạy ngân hàng với cả ba biến gây lỗi bằng 0. Bộ đo tự động bên dưới gửi 200 thanh toán, đồng thời 10, mỗi lần 1.000đ; đọc stats; đợi 6 s; rồi gửi thêm 5 thanh toán.

### 4. Đứt sau trừ tiền, lỗi tạm thời, từ chối

Chạy riêng từng cấu hình, khởi động lại ngân hàng trước mỗi lượt đo:

```powershell
$env:DELAY_MS='0'
$env:FAIL_RATE='0'
$env:DROP_RATE='0.3'
npm.cmd run start:bank
# Dừng ngân hàng, đổi DROP_RATE=0 và FAIL_RATE=0.3 rồi chạy lại cho ca (b).
```

Mỗi ca gửi 60 thanh toán lần lượt. Với ca (c), tắt lỗi giả lập và gửi `{"amount":25000000}`: nhận 402 + FAILED, ngân hàng chỉ nhận 1 request. Khi đo thủ công, khởi động lại cả hai service giữa các ca để công nợ và stats bắt đầu lại; riêng ca phục hồi (1) giữ nguyên Fee Service.

## Kiểm thử và số liệu trước / sau

```powershell
npm.cmd test
npm.cmd run benchmark
```

Hai lệnh tự mở service trên các cổng trống do hệ điều hành cấp, không dùng cổng 4001/4002 và không phụ thuộc các service bạn đang chạy. Khoảng vài chục giây cho toàn bộ bài đo. Benchmark dùng seed cố định cho lỗi; service thông thường dùng xác suất ngẫu nhiên nên kết quả mỗi lần có thể khác.

- `test/payments.test.js`: kiểm chứng bốn tình huống, kiểm tra dữ liệu, race condition, đối soát PENDING, giới hạn công nợ và lỗi 500 kéo dài.
- `results/benchmark.md`: bảng số liệu thật, phù hợp trình bày cuối buổi.
- `results/benchmark.json`: dữ liệu thô của lần đo gần nhất.
- `postman/Tuition.postman_collection.json`: import vào Postman, sửa collection variables `feeUrl` và `bankUrl` nếu đổi cổng.

Baseline là cấu hình tắt keep-alive, không retry và timeout mỗi lần 10 s; vẫn giữ quy tắc nghiệp vụ đúng. Bản sau dùng các giá trị mặc định ở bảng cấu hình. Script chạy cả hai cấu hình trên dữ liệu mới và ghi lại kết quả, không giả lập số liệu trước sửa. Không suy ra hiệu năng mạng thật từ chênh lệch thời gian trên loopback; số lượng kết nối và hành vi lỗi là các phép đo chính.

## Giới hạn của bài thực hành

Dữ liệu mất khi service khởi động lại, đúng phạm vi bộ nhớ của đề. Reference ngân hàng có UUID của phiên Fee Service kèm P1/P2 để tránh trùng khóa khi Fee Service khởi động lại mà ngân hàng còn chạy; paymentId hiển thị vẫn là P1/P2. Tuy nhiên UUID không thay thế lưu trữ bền vững: khởi động lại có thể mất các lệnh PENDING và công nợ, và bank khởi động lại sẽ mất sổ idempotency. Không restart các service giữa lúc đối soát một lệnh thực tế.

Triển khai thực tế cần cơ sở dữ liệu có giao dịch, khóa idempotency bền vững, API tra cứu/webhook ngân hàng, cơ chế đối soát và xác thực người dùng. Bản này không tự chạy đối soát nền; endpoint retry là cách xác nhận PENDING trong bài thực hành.
