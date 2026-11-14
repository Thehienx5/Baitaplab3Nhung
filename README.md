# Lab 3 – Giám sát và cảnh báo người chạy

Đề 1: sử dụng **ESP32, BMP180, FreeRTOS và MQTT** để đo nhiệt độ môi trường, áp suất khí quyển và tính độ cao. Dữ liệu được in ra Serial, gửi lên MQTT Broker và hiển thị trên web. Người dùng có thể theo dõi số đo, xem biểu đồ và điều khiển LED, còi từ giao diện.

## Mở dự án

- [Chạy mô phỏng trên Wokwi](https://wokwi.com/projects/477913990577984513)
- [Xem báo cáo Word](baocao/Bao_cao_Lab3_Runner.docx)
- [Mã nguồn ESP32](wokwi/sketch.ino)
- [Mã nguồn giao diện web](web/index.html)

## Các chức năng

- Đọc cảm biến BMP180 mỗi 2 giây; hiển thị nhiệt độ (°C), áp suất (hPa) và độ cao (m).
- Truyền dữ liệu từ ESP32 lên broker qua Wi-Fi; web nhận dữ liệu qua MQTT WebSocket.
- Hiển thị số đo và hai biểu đồ nhiệt độ, độ cao theo thời gian.
- Cảnh báo tự động bằng LED và còi khi nhiệt độ vượt giới hạn, độ cao thay đổi đột ngột hoặc mất dữ liệu cảm biến.
- Điều khiển LED, còi ở chế độ manual và chuyển về chế độ tự động trên web.
- Trang chính hiển thị trạng thái MQTT. Các mục kết nối, nhật ký và cài đặt nằm trong phần **MQTT**.

## Cách chạy

1. Mở [dự án Wokwi](https://wokwi.com/projects/477913990577984513), nhấn **Start Simulation** và chờ ESP32 kết nối Wi-Fi, MQTT. Có thể theo dõi thông báo và số đo trong Serial Monitor.
2. Tải dự án về máy và giải nén. Mở `web/index.html`; giữ nguyên các tệp đi kèm trong thư mục `web` để giao diện hoạt động đầy đủ.
3. Web tự kết nối broker. Vào **MQTT → Settings** để kiểm tra địa chỉ broker, topic gốc và đường dẫn dự án. Topic của web phải trùng với topic trong code ESP32.
4. Khi nhận được dữ liệu, các thẻ số và biểu đồ sẽ cập nhật. Kết nối broker thành công chưa có nghĩa ESP32 đang gửi dữ liệu; cần kiểm tra cả số đo và trạng thái thiết bị.
5. Chọn chế độ manual để thử nút LED, còi. Chuyển về tự động để thiết bị cảnh báo theo dữ liệu cảm biến.

Máy tính cần có Internet và mô phỏng Wokwi phải đang chạy để nhận dữ liệu từ ESP32.

## Cấu hình MQTT

| Thành phần | Giá trị mặc định |
|---|---|
| Broker cho ESP32 | `broker.emqx.io`, cổng `1883` |
| Broker cho web | `wss://broker.emqx.io:8084/mqtt` |
| Topic gốc | `lab3/runner/thehienx5-20261114` |
| Gửi số đo | `<topic gốc>/telemetry` |
| Gửi trạng thái LED, còi và chế độ | `<topic gốc>/state` |
| Nhận lệnh điều khiển | `<topic gốc>/cmd` |
| Trạng thái kết nối ESP32 | `<topic gốc>/status` |

ESP32 và web sử dụng cùng broker nhưng kết nối bằng hai giao thức khác nhau: ESP32 dùng MQTT qua TCP, trình duyệt dùng MQTT qua WebSocket. Nếu đổi broker hoặc topic trong Settings của web, cần sửa cấu hình tương ứng trong code ESP32.

## Kết nối mạch

| Thiết bị | Kết nối với ESP32 |
|---|---|
| BMP180 VCC | 3V3 |
| BMP180 GND | GND |
| BMP180 SDA | GPIO21 |
| BMP180 SCL | GPIO22 |
| LED | GPIO32 qua điện trở 220 Ω; cực âm về GND |
| Còi piezo | GPIO26; chân còn lại về GND |

Sơ đồ chi tiết nằm trong [wokwi/diagram.json](wokwi/diagram.json).

## Phân chia task FreeRTOS

| Task | Core | Ưu tiên | Công việc |
|---|---:|---:|---|
| `TaskTransmit` | 0 | 1 | Quản lý Wi-Fi, MQTT; lấy dữ liệu từ queue để gửi lên broker và nhận lệnh từ web |
| `TaskRead` | 1 | 2 | Đọc BMP180 mỗi 2 giây, in Serial, gửi số đo vào `dataQueue` và dữ liệu cảnh báo vào `dataAlert` |
| `TaskAlert` | 1 | 3 | Nhận dữ liệu cảnh báo, xử lý lệnh manual và điều khiển LED, còi |

Hai queue `dataQueue` và `dataAlert` truyền dữ liệu từ task đọc đến các task xử lý. `commandQueue` chuyển lệnh điều khiển tới task cảnh báo; `stateQueue` chuyển trạng thái thiết bị về task truyền.

## Quy tắc cảnh báo đang sử dụng

- **Nhiệt độ:** cảnh báo khi dưới 20 °C hoặc trên 35 °C; xóa cảnh báo khi trở lại khoảng 21–34 °C để tránh bật/tắt liên tục gần ngưỡng.
- **Độ cao:** cảnh báo khi hai mẫu liên tiếp chênh lệch từ 3 m, với khoảng cách thời gian giữa hai mẫu từ 1–3 giây. Cảnh báo giữ 10 giây kể từ lần phát hiện gần nhất.
- **Cảm biến:** cảnh báo khi mẫu đọc không hợp lệ hoặc quá 6 giây không có mẫu hợp lệ.

Các ngưỡng phục vụ bài mô phỏng, có thể chỉnh trong [AlertEngine.h](wokwi/AlertEngine.h). BMP180 đo **nhiệt độ môi trường, không phải thân nhiệt**; độ cao tính từ áp suất cần hiệu chuẩn áp suất mực nước biển khi sử dụng thực tế.

