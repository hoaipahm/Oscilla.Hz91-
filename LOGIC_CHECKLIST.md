# Kiểm kê logic Music Green — 21/10/2026

Các mục dưới đây mô tả bản hiện tại, không phải danh sách ý tưởng chưa làm.

| Nhóm | Hành vi đã triển khai | Kiểm tra |
|---|---|---|
| Lưu trữ | Thư viện, playlist, bookmark, hàng chờ, ngôn ngữ, màu, âm lượng, tốc độ và vị trí nghe còn sau khi mở lại | Desktop mở app hai lần; bản `.exe` đóng cửa sổ và đọc lại JSON |
| Ghi an toàn | File JSON được ghi qua tệp tạm rồi đổi tên; các lần ghi xếp hàng; bản lỗi giữ bản sao phục hồi | Unit: ghi đồng thời, mở lại, JSON hỏng |
| Chống mở hai bản | Chỉ một cửa sổ ứng dụng dùng cùng thư mục dữ liệu | Đã đọc luồng `requestSingleInstanceLock`; chưa kiểm thử hai cửa sổ tương tác |
| Trùng file | Nhận ra cùng đường dẫn, đổi tên, chép sang thư mục khác, trùng ngay trong cùng lượt thêm | Unit + desktop với file được sao chép/đổi tên |
| Trùng MP3 có đổi tag | SHA-256 phần âm thanh bỏ ID3v2 đầu và ID3v1 cuối thông thường | Unit với payload giống nhau và tag khác nhau |
| Tên giống, nhạc khác | Không chặn nhầm chỉ vì tiêu đề giống nhau | Unit |
| Đổi tên / di chuyển | Chọn lại file để nối lại đường dẫn bằng fingerprint; giữ bookmark, playlist và ID | Unit + desktop |
| File bị mất | Giữ mục thư viện, đánh dấu không tìm thấy; có nút kiểm tra lại | Unit kiểm tra file đã xóa; luồng giao diện đã đọc |
| File rỗng / hỏng | Bỏ qua, không làm hỏng phần thư viện đã có, có báo cáo | Unit |
| Hủy chọn file | Không thay đổi thư viện | Đã đọc nhánh hủy hộp thoại; chưa thao tác tay trên mọi kiểu hộp thoại |
| Phát nhạc | MP3/WAV thật qua bộ giải mã Electron; pause, stop, seek và tốc độ | Desktop + bản `.exe` |
| Tua | ±10 giây và thanh tua; tải đúng byte-range, có thời lượng hữu hạn; tua khi pause giữ pause | Unit byte-range + desktop MP3/WAV + bản `.exe` MP3 |
| Lặp | Tắt / cả hàng đợi / một bài; hết danh sách khi tắt lặp thì dừng | Unit + desktop tự kết thúc một bài |
| Ngẫu nhiên | Không lặp lại bài trước khi hết một lượt; nút trước/sau dùng lịch sử phiên | Unit shuffle; chưa chạy nghe trọn một playlist dài nhiều giờ |
| Playlist | Tạo, đổi tên, xóa, thêm/bỏ bài; chuỗi thao tác lưu được xếp hàng | Desktop tạo/thêm/mở lại; các nhánh đổi tên/xóa đã đọc |
| Bookmark | Bật/tắt và lọc riêng; còn sau khi mở lại | Desktop |
| Hàng chờ | Thêm, phát tiếp theo, không thêm trùng, lên/xuống, bỏ bài/xóa tất cả; còn sau mở lại | Desktop |
| Bỏ khỏi thư viện | Dọn bookmark/playlist/hàng chờ liên quan, giữ file gốc | Desktop với MP3 mẫu, kiểm tra file vẫn tồn tại |
| Xóa khỏi máy | Xác nhận native đúng đường dẫn; mặc định Hủy; dùng Thùng rác, không xóa vĩnh viễn | Desktop: hủy + đưa WAV thử vào Thùng rác, kiểm tra file khác còn nguyên |
| Sóng bắt buộc | 4 đường sóng và phổ 96 dải lấy từ analyser âm thanh thật | Desktop đo mẫu khác 0; bản `.exe` đo MP3 thật và chụp ảnh |
| Synth | 8 preset, nhập tần số riêng, nhiều lớp, volume riêng, nút tắt toàn bộ | Desktop nhiều lớp + bản `.exe` |
| Camera | Tất cả ảnh từ thư mục/subfolder, chọn tay, tự chuyển, chỉnh chu kỳ; không có bản tin/webcam | Desktop + bản `.exe` tải ảnh cuối trong 17 ảnh |
| Hiệu năng | Đọc file theo stream; nhóm quét giới hạn; bảng 100 bài/trang, hàng chờ 50 bài/trang; giảm animation khi ẩn / reduced motion | Unit stream; UI ở cửa sổ thường/nhỏ; chưa benchmark thư viện 20.000 bài thật |
| Quyền truy cập | Renderer sandbox, context isolation, API giới hạn, chặn mạng và URL không có trong thư viện | Desktop + bản `.exe`; npm audit không có advisory tại thời điểm kiểm tra |
| VI / EN | Nhãn, tooltip, thông báo, menu; tên bài/playlist giữ nguyên dữ liệu của bạn | Desktop + bản `.exe` |

## Kết quả chạy

- `npm.cmd test`: **18 bài test logic đạt**.
- `npm.cmd run test:desktop`: **60 kiểm tra ứng dụng + 9 kiểm tra mở lại đạt**.
- `node tests/packaged.cjs`: **13 kiểm tra trên bản `.exe` đạt**.
- `npm.cmd audit --json`: **0 lỗ hổng đã biết** trong kết quả lần chạy.
- `npm.cmd run build`: đã tạo ứng dụng Windows x64. Đây là bản chạy trong thư mục, chưa phải bộ cài có ký chứng thư.

## Giới hạn thực tế

- Nhạc/ảnh được tham chiếu từ đĩa, không nhân đôi vào ứng dụng. Chuyển file thì chọn lại để nối đường dẫn.
- Fingerprint byte không tự nhận hai bản mã hóa khác bitrate/codec là cùng bản thu âm. Không dùng tên bài đơn thuần để chặn vì có thể làm mất bản live/remix hợp lệ.
- Ngày tạo file của Windows có thể khác ngày tải xuống. Có thêm lựa chọn ngày thêm thư viện để sắp xếp ổn định.
- Mất điện/kill cưỡng bức có thể mất vài giây vị trí nghe từ lần autosave gần nhất; đóng cửa sổ bình thường có bước lưu cuối.
- Chưa kiểm thử ổ mạng/ổ rời ngắt đột ngột, thiết bị Bluetooth đổi giữa bài, thiết bị âm thanh thật khác nhau, và toàn bộ codec trong các container được nhận.
- Bộ test xóa chỉ dùng file WAV nó tự tạo; không xóa file nhạc của người dùng.

## Cập nhật 1.0.1 — chọn thư mục

Hộp thoại chọn thư mục không hiện từng MP3 là hành vi của Windows. Nút xác nhận giờ ghi rõ **Thêm thư mục này** / **Add this folder**. Sau khi quét, ứng dụng về Thư viện và xóa bộ lọc tìm kiếm; báo số file tìm thấy, thêm mới, trùng và đường dẫn thư mục. Có hướng dẫn và thông báo thư mục không có nhạc. Đã thêm kiểm thử quét thư mục lồng nhau, tên Unicode và nhập thư mục khi đang ở mục bookmark có tìm kiếm.

## Cập nhật 1.0.2 — playlist và icon

Tạo playlist có danh sách tên bài để chọn ngay. Playlist rỗng có nút Chọn bài hát; có tìm kiếm, chọn tất cả kết quả và bỏ chọn. Hủy giữ nguyên danh sách, Lưu cập nhật ngay tên bài trên bảng. Icon sửa, xóa và playlist dùng SVG nét đơn theo màu giao diện. Kiểm thử desktop bao gồm tạo có bài, sửa lựa chọn, giữ bài đã chọn khi lọc tìm kiếm, hủy không đổi dữ liệu, thêm vào playlist rỗng và lưu qua lần mở lại.
