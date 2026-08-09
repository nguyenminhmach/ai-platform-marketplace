import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-16 border-t border-zinc-200 py-6 dark:border-zinc-800">
      <div className="mx-auto flex max-w-5xl flex-wrap justify-center gap-4 px-6 text-xs text-zinc-500 dark:text-zinc-400">
        <Link href="/terms" className="hover:text-zinc-900 dark:hover:text-zinc-50">
          Điều khoản sử dụng &amp; Hoàn tiền
        </Link>
        <span>·</span>
        <Link href="/support" className="hover:text-zinc-900 dark:hover:text-zinc-50">
          Hỗ trợ
        </Link>
      </div>
    </footer>
  );
}
