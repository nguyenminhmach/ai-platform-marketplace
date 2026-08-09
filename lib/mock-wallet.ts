export type CreditPackage = {
  id: string;
  credits: number;
  priceVnd: number;
  isBestValue?: boolean;
};

export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: "goi-nho", credits: 100, priceVnd: 49000 },
  { id: "goi-vua", credits: 300, priceVnd: 129000, isBestValue: true },
  { id: "goi-lon", credits: 1000, priceVnd: 399000 },
  { id: "goi-doanh-nghiep", credits: 5000, priceVnd: 1799000 },
];

export type WalletTransaction = {
  id: string;
  type: "topup" | "usage" | "refund" | "bonus";
  label: string;
  amount: number; // credit, dương = cộng, âm = trừ
  createdAt: string; // đã format sẵn cho demo
};

export const TRANSACTION_TYPE_LABEL: Record<WalletTransaction["type"], string> = {
  topup: "Nạp credit",
  usage: "Sử dụng",
  refund: "Hoàn credit",
  bonus: "Thưởng",
};

export const MOCK_TRANSACTIONS: WalletTransaction[] = [
  { id: "tx-1", type: "usage", label: "Tóm tắt văn bản", amount: -5, createdAt: "03/08/2026 14:22" },
  { id: "tx-2", type: "topup", label: "Nạp gói Vừa", amount: 300, createdAt: "02/08/2026 09:10" },
  { id: "tx-3", type: "usage", label: "Viết caption Facebook/TikTok", amount: -8, createdAt: "01/08/2026 20:45" },
  { id: "tx-4", type: "refund", label: "Hoàn credit — lỗi xử lý", amount: 15, createdAt: "01/08/2026 20:40" },
  { id: "tx-5", type: "usage", label: "Viết mô tả sản phẩm từ ảnh", amount: -15, createdAt: "01/08/2026 20:38" },
  { id: "tx-6", type: "bonus", label: "Tặng credit dùng thử", amount: 20, createdAt: "30/07/2026 11:00" },
];
