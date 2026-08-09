import Link from "next/link";

export const metadata = {
  title: "Hỗ trợ | AI Marketplace",
};

export default function SupportPage() {
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
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Hỗ trợ</h1>
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          Gặp vấn đề về credit, thanh toán, hoặc Mini App chạy lỗi? Liên hệ qua kênh phù hợp bên dưới.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <a
            href="https://zalo.me/0377116772"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl border border-zinc-200 bg-white p-5 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">Zalo</p>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Phản hồi nhanh trong giờ hành chính (8:00 - 21:00)
            </p>
            <p className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              0377 116 772 →
            </p>
          </a>

          <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">Chat AI</p>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Trả lời tức thì 24/7 cho câu hỏi thường gặp về credit, thanh toán, Mini App
            </p>
            <p className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              Bấm khung chat ở góc dưới màn hình
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-2 font-semibold text-zinc-900 dark:text-zinc-50">Khi liên hệ, anh cung cấp giúp:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Email tài khoản đã đăng ký</li>
            <li>Mã đơn hàng nếu liên quan thanh toán (dạng <code>DH000001</code>, xem ở trang Ví)</li>
            <li>Mô tả ngắn gọn vấn đề gặp phải</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
