# Prompt Challenge — web app cho gian hàng clubday

Web app 4 màn hình đồng bộ real-time qua Socket.io:
- `/btc.html` — bạn (BTC) điều khiển: upload ảnh reference, bấm giờ, "gập xuống", xem kết quả, bảng xếp hạng
- `/team.html?team=A` và `/team.html?team=B` — 2 tablet/điện thoại cho 2 đội chơi nhập prompt
- `/display.html` — màn hình lớn cho khán giả xem trực tiếp

## Cài đặt (làm trước ngày hội, cần internet)

1. Cài Node.js 18+ nếu máy chưa có.
2. Mở terminal tại thư mục này, chạy:
   ```
   npm install
   ```
3. Copy `.env.example` thành `.env`, điền 2 API key:
   - `OPENAI_API_KEY` — dùng để sinh ảnh từ prompt (mặc định code dùng model `gpt-image-1` của OpenAI). **Nếu bạn có API "image gen 2.5" khác (không phải OpenAI), báo mình endpoint/tài liệu cụ thể, mình sẽ sửa lại hàm `generateImage` trong `server.js` cho đúng.**
   - `ANTHROPIC_API_KEY` — dùng để AI (Claude) chấm điểm so sánh ảnh.
4. Chạy thử:
   ```
   npm start
   ```
   Terminal sẽ in ra 4 link, ví dụ:
   ```
   BTC:      http://localhost:3000/btc.html
   Đội A:    http://localhost:3000/team.html?team=A
   Đội B:    http://localhost:3000/team.html?team=B
   Màn hình: http://localhost:3000/display.html
   ```

## Chạy tại booth (không cần internet mạnh, chỉ cần LAN)

- Laptop chạy `npm start` đóng vai trò server — cắm sạc, để yên suốt sự kiện.
- Các thiết bị khác (tablet đội A/B, TV/laptop hiển thị) **kết nối cùng 1 mạng WiFi** với laptop server, rồi mở trình duyệt vào:
  `http://<địa-chỉ-IP-laptop>:3000/team.html?team=A` (thay `<địa-chỉ-IP-laptop>` bằng IP LAN của laptop, xem bằng `ipconfig` / `ifconfig`).
- Việc **sinh ảnh** và **chấm điểm** vẫn cần internet (vì gọi API OpenAI/Anthropic) — đảm bảo laptop server có mạng ổn định.

## Cách vận hành 1 vòng đấu

1. Tab **BTC**: nhập tên 2 đội → "Lưu tên đội".
2. Upload ảnh reference → vòng mới sẵn sàng, cả 2 đội thấy trạng thái "đang chờ".
3. Bấm **"Bắt đầu vòng (xem ảnh)"** — cả đội A, đội B, màn hình lớn đều tự hiện ảnh + đếm ngược.
4. Muốn kết thúc xem ảnh sớm hơn → bấm **"Gập xuống"**. Hết giờ tự động chuyển sang bước nhập prompt.
5. 2 đội gõ prompt trên tablet, bấm gửi (chỉ gửi được 1 lần).
6. Khi cả 2 đội gửi xong, hệ thống **tự động** gọi API sinh ảnh rồi chấm điểm — không cần bạn bấm gì thêm. (Nếu 1 đội "đứng hình", bấm **"Ép tạo ảnh dù thiếu prompt"** để không kẹt cả hàng chờ.)
7. Kết quả (ảnh 2 đội + điểm sao + lý do) hiện trên cả 3 màn hình. Điểm được cộng dồn vào **bảng xếp hạng chung** ở cuối trang BTC.
8. Bấm **"Reset vòng này"**, upload ảnh reference mới → tiếp đội tiếp theo.

## Chỉnh cách AI chấm điểm

Ở cuối trang BTC có ô "System prompt cho AI chấm điểm" — sửa trực tiếp nếu muốn đổi tiêu chí (vd ưu tiên màu sắc hơn bố cục), bấm "Lưu" là áp dụng ngay cho vòng tiếp theo.

## Giới hạn cần biết trước ngày thi

- Thời gian sinh ảnh + chấm điểm thường mất **10-30 giây** tùy API — nên có màn hình "đang xử lý" để khán giả không đứng chờ vô nghĩa.
- Nếu prompt bị OpenAI từ chối (nội dung nhạy cảm, người thật...), vòng đó sẽ báo lỗi ở trang BTC — bấm "Reset vòng này" và cho đội đó chơi lại vòng bù.
- State hiện lưu trong RAM của server — nếu tắt server giữa chừng, bảng xếp hạng sẽ mất. Muốn lưu bền hơn (vd ghi ra file/Google Sheet), báo mình để bổ sung.
