# Lab 3 · ESP32 Runner Monitor

Giám sát nhiệt độ môi trường, áp suất và độ cao khí áp bằng BMP180; FreeRTOS ba task, MQTT và web điều khiển LED/Còi.

**Wokwi:** https://wokwi.com/projects/477913990577984513

## Chạy mô phỏng

1. Mở dự án Wokwi. Nội dung `firmware/runner/runner.ino` là `sketch.ino` trên Wokwi.
2. Giữ `AlertEngine.h`, `diagram.json`, `libraries.txt` cùng dự án. Hai thư viện là Adafruit BMP085 Library và PubSubClient.
3. Bấm Start. Serial 115200 xác nhận TaskTransmit Core 0; TaskRead và TaskAlert Core 1.
4. Mở **MO_DASHBOARD.html** bằng Chrome hoặc Edge. Tệp này chứa sẵn CSS, MQTT.js và mã ứng dụng, nên có thể chạy độc lập. Bản tiện dụng đã được đặt riêng ở `E:\MO_DASHBOARD.html`. Nếu chỉnh sửa mã nguồn trong `web/`, cần giữ cả thư mục đó. Dashboard mặc định tự kết nối MQTT. Nếu đã tắt tùy chọn tự kết nối, vào **MQTT → Kết nối** rồi bấm **Kết nối lại**.
5. Chờ số đo thật qua broker; LED và Còi chỉ cập nhật trạng thái sau phản hồi ESP32. Trang chính chỉ hiện trạng thái MQTT hoạt động hay chưa; broker, topic và liên kết bài nằm ở **MQTT → Settings**.

## Đấu dây

| Thiết bị | ESP32 |
|---|---|
| BMP180 VCC / GND | 3V3 / GND |
| BMP180 SDA / SCL | GPIO21 / GPIO22 |
| LED A qua 220 Ω / C | GPIO32 / GND |
| Piezo + / − | GPIO26 / GND |

Không nối loa/còi tải lớn trực tiếp GPIO trên phần cứng thật; cần driver phù hợp.

## Kiến trúc FreeRTOS

| Task | Core | Ưu tiên | Stack | Chu kỳ |
|---|---:|---:|---:|---|
| TaskTransmit | 0 | 1 | 6144 byte | 50 ms, retry WiFi 10 s / MQTT 5 s |
| TaskRead | 1 | 2 | 4096 byte | 2000 ms |
| TaskAlert | 1 | 3 | 4096 byte | 50 ms |

`dataQueue` chứa toàn bộ Data, `dataAlert` chứa nhiệt độ + độ cao + valid. Hai queue dài 1 dùng overwrite để giữ mẫu mới nhất. `commandQueue` dài 8 truyền lệnh đến task duy nhất sở hữu GPIO. `stateQueue` trả trạng thái để task mạng publish. Mutex bảo vệ Serial. Mỗi đối tượng I2C, MQTT và GPIO có một task sở hữu.

## MQTT

- ESP32: `broker.emqx.io:1883` TCP.
- Web: `wss://broker.emqx.io:8084/mqtt`.
- Topic gốc: `lab3/runner/thehienx5-20261114`.
- `/telemetry`: JSON số đo, QoS 0, không retain.
- `/state`: JSON mode/LED/Còi/các cờ, QoS 0, không retain.
- `/cmd`: `MODE_AUTO`, `MODE_MANUAL`, `LED_ON`, `LED_OFF`, `BUZZER_ON`, `BUZZER_OFF`; không retain.
- `/status`: `online`, Last Will `offline` có retain.

Broker công cộng chỉ dành cho dữ liệu mô phỏng; topic riêng không tạo quyền riêng tư. Đưa lên hệ thống thật cần TLS, xác thực và ACL. Web không tạo telemetry giả. Hơn 6 s không có telemetry sẽ xóa số và báo quá hạn; nút bị khóa khi state quá hạn.

## Cảnh báo

- Nhiệt độ dưới 20 °C hoặc trên 35 °C bật cờ; 21–34 °C xóa cờ. Các khoảng chuyển tiếp giữ cờ cũ (hysteresis).
- Biến thiên độ cao ≥ 3 m giữa hai mẫu cách 1–3 s bật cờ độ cao trong 10 s.
- Dữ liệu không hợp lệ hoặc >6 s không có mẫu hợp lệ bật cờ lỗi cảm biến.
- AUTO: LED/Còi theo OR của ba cờ.
- Nút LED/Còi vào MANUAL; cờ vẫn tính, nhưng đầu ra theo lệnh. Hết 60 s không có lệnh sẽ trở về AUTO.
- BMP180 đo nhiệt độ môi trường quanh cảm biến, không phải thân nhiệt. Độ cao dùng p₀=101325 Pa, cần hiệu chuẩn theo thời tiết. Không dùng bản Lab để chẩn đoán hoặc phát hiện ngã thực tế.

## Biên dịch cục bộ

Đã Verify bằng Arduino CLI đi kèm IDE, ESP32 core **2.0.17**, Adafruit BMP085 **1.2.4**, PubSubClient **2.8.0**.

```sh
arduino-cli lib install "Adafruit BMP085 Library" "PubSubClient"
arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir firmware/build firmware/runner
```

Kết quả tại máy: flash 763973 byte (58%); RAM tĩnh 45348 byte (13%). RAM động của task/queue/network còn cấp phát khi chạy. Nếu đường dẫn thư viện Unicode gây lỗi header, dùng đường dẫn ASCII với `--libraries`.

`firmware/build/runner.ino.bin` là ứng dụng, nạp flash tại 0x10000 khi có bootloader phù hợp. Bootloader tại 0x1000, partitions tại 0x8000. Dùng chức năng Upload của Arduino IDE để tránh chọn sai địa chỉ khi nạp board thật. Wokwi hiện đã chạy bản biên dịch trên web; firmware cục bộ là bản dự phòng.

## Kiểm thử và bằng chứng

Ảnh và log trong `evidence/` ghi lại dữ liệu bình thường, lệnh LED/Còi, nhiệt độ 40 °C, nhiệt độ 15 °C và bước áp suất 101325→101200 Pa. Xem bảng kết quả trong báo cáo. Chưa thử trên thiết bị đeo thực tế.

## Báo cáo và lưu đồ

- `docs/Bao_cao_Lab3_Runner.docx`: lý thuyết, mạch, task/queue, lưu đồ, code, giải thích, hướng dẫn và bằng chứng.
- `docs/Luu_do_chinh_sua.drawio`: năm trang lưu đồ đen trắng chỉnh sửa bằng diagrams.net.
- Lưu đồ trong Word là các hình vector có chữ chỉnh sửa được.

## Thư viện bên thứ ba

MQTT.js 5.10.4 được tải từ bản phân phối npm chính thức qua unpkg và giữ thông tin giấy phép trong tệp minify. Firmware dùng thư viện Adafruit BMP085 và PubSubClient, cài qua Library Manager. Các thư viện giữ giấy phép riêng của tác giả.


## Runner Studio và Settings

- **Tổng quan**: trạng thái hoạt động MQTT, trạng thái dữ liệu ESP32, ba thẻ số, hai biểu đồ và các nút LED/Còi/AUTO.
- **MQTT → Kết nối**: Kết nối lại, Ngắt kết nối, số gói đã nhận, lần cập nhật cuối và phản hồi đăng ký topic.
- **MQTT → Nhật ký**: dữ liệu nhận thật từ broker và lệnh đã gửi, có nút xóa phần nhật ký hiển thị.
- **MQTT → Settings**: địa chỉ broker WebSocket, topic gốc, tự kết nối khi mở trang, liên kết Wokwi và GitHub tùy chọn. Lưu và áp dụng sẽ kiểm tra, lưu trên trình duyệt rồi thiết lập lại kết nối. Có nút khôi phục mặc định.
- Thay topic trên giao diện không đổi BASE trong firmware. Hai phía phải khớp nhau.
- Trạng thái MQTT của web độc lập với độ mới của ESP32. Web có thể vẫn kết nối broker khi Wokwi tạm dừng; lúc đó số đo bị xóa và báo quá hạn, điều khiển bị khóa.

## Ảnh mạch và báo cáo mới

Ảnh `evidence/13-mach-wokwi-ro.jpg` là vùng mạch đã phóng to, không bị bảng popup che và không cắt board. Ảnh toàn cảnh phiên mô phỏng nằm ở `14-mach-wokwi-toan-canh.jpg`. Ảnh `v3-*` là Runner Studio mới: nền tối, điều hướng ngang, số đo lớn và cảnh báo bên phải. Các ảnh `v2-*` và số 01–12 giữ lại làm bằng chứng các phiên thử trước.

Gói này được chuẩn bị để tải lên GitHub sau; không bao gồm thông tin đăng nhập hoặc kết nối tài khoản GitHub. Chưa tạo kho GitHub.

## Tệp HTML độc lập

`MO_DASHBOARD.html` chứa đầy đủ giao diện và thư viện MQTT. Không dùng CDN, phông chữ ngoài hoặc tài nguyên giao diện tương đối. Kết nối MQTT cần Internet và mô phỏng Wokwi đang chạy. Nếu còn mở tab tạm từ ZIP cũ, đóng tab đó và mở lại tệp HTML mới. Mã nguồn để chỉnh sửa vẫn ở `web/`.
