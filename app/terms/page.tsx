import Link from "next/link";

export const metadata = {
  title: "Điều khoản sử dụng | AI Marketplace",
};

export default function TermsPage() {
  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-3xl items-center px-6 py-4">
          <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← Quay lại Danh mục
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Điều khoản sử dụng &amp; Chính sách hoàn tiền
        </h1>
        <p className="mb-8 text-sm text-zinc-500 dark:text-zinc-400">Cập nhật lần cuối: 04/08/2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          <section>
            <h2 className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              1. Về credit
            </h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>Credit dùng để chạy các Mini App AI trên nền tảng, quy đổi theo mức giá niêm yết tại trang Ví.</li>
              <li>Credit tặng khi đăng ký (20 credit dùng thử) và credit đã nạp <strong>không có hạn sử dụng</strong>, không quy đổi ngược lại thành tiền mặt.</li>
              <li>Mỗi lượt chạy Mini App trừ đúng số credit hiển thị trước khi xác nhận — không phát sinh phí ẩn.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              2. Chính sách hoàn credit
            </h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Tự động hoàn 100%</strong> nếu Mini App gặp lỗi kỹ thuật (timeout, lỗi hệ thống) và không trả về kết quả — không cần liên hệ hỗ trợ, credit được hoàn ngay lập tức.
              </li>
              <li>
                Nếu kết quả AI trả về <strong>không đúng chủ đề/yêu cầu</strong> (ví dụ hỏi một đằng AI trả lời một nẻo), liên hệ kênh hỗ trợ để được xem xét hoàn credit thủ công.
              </li>
              <li>
                Nếu kết quả AI đúng yêu cầu nhưng <strong>không như ý muốn</strong> về mặt sáng tạo (văn phong, cách diễn đạt), đây là đặc thù của AI tạo sinh — trường hợp này không đủ điều kiện hoàn credit. Anh nên thử chạy lại với input rõ ràng hơn.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              3. Hoàn tiền thật (khi đã thanh toán bằng tiền)
            </h2>
            <p>
              Hoàn tiền thật (không chỉ hoàn credit) chỉ áp dụng khi có lỗi thanh toán — ví dụ đã chuyển khoản nhưng
              credit chưa được cộng sau 30 phút. Liên hệ kênh hỗ trợ kèm mã đơn hàng (dạng <code>DH000001</code>) để
              được đối chiếu và xử lý.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              4. Trách nhiệm về nội dung do AI tạo ra
            </h2>
            <p>
              Nội dung (văn bản, mô tả sản phẩm, caption...) do các Mini App AI tạo ra chỉ mang tính tham khảo/gợi ý.
              Người dùng tự chịu trách nhiệm kiểm tra tính chính xác và phù hợp trước khi sử dụng cho mục đích thương
              mại hoặc công khai. Nền tảng không chịu trách nhiệm về hậu quả phát sinh từ việc sử dụng trực tiếp nội
              dung AI mà không qua kiểm duyệt của người dùng.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              5. Bảo mật dữ liệu
            </h2>
            <p>
              Thông tin tài khoản (email) chỉ dùng để xác thực đăng nhập và liên hệ khi cần thiết. Nội dung anh nhập
              vào Mini App được gửi tới nhà cung cấp AI để xử lý và không được lưu trữ lâu dài ngoài mục đích vận
              hành/khắc phục sự cố.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              6. Liên hệ hỗ trợ
            </h2>
            <p>
              Mọi thắc mắc về credit, thanh toán, hoặc lỗi kỹ thuật, anh liên hệ qua trang{" "}
              <Link href="/support" className="underline">Hỗ trợ</Link>.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
