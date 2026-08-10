// lib/sepay.ts — pure helpers cho Sepay VietQR integration, không phụ thuộc framework
import { timingSafeEqual } from "crypto";

export function generateVietQRUrl(opts: {
  accountNumber: string;
  bank: string;
  amount: number;
  content: string;
  template?: "compact" | "qronly" | "";
}): string {
  const params = new URLSearchParams({
    acc: opts.accountNumber,
    bank: opts.bank,
    amount: String(Math.floor(opts.amount)),
    des: opts.content,
  });
  if (opts.template) params.set("template", opts.template);
  return `https://qr.sepay.vn/img?${params.toString()}`;
}

/** Parse "DH<digits>" (nạp credit) hoặc "GS<digits>" (gia hạn thuê bao) từ nội dung chuyển khoản */
export function parseOrderCodeFromContent(
  content: string
): { type: "topup" | "subscription"; code: string } | null {
  if (!content) return null;
  const topupMatch = content.match(/DH\s*(\d{1,10})/i);
  if (topupMatch) return { type: "topup", code: `DH${topupMatch[1].padStart(6, "0")}` };
  const subMatch = content.match(/GS\s*(\d{1,10})/i);
  if (subMatch) return { type: "subscription", code: `GS${subMatch[1].padStart(6, "0")}` };
  return null;
}

/** So sánh timing-safe cho auth header, chống timing attack */
export function verifySepayAuth(authHeader: string | null, expectedKey: string): boolean {
  if (!authHeader || !expectedKey) return false;

  let providedKey: string;
  if (authHeader.startsWith("Apikey ")) providedKey = authHeader.slice(7);
  else if (authHeader.startsWith("Bearer ")) providedKey = authHeader.slice(7);
  else return false;

  try {
    const expected = Buffer.from(expectedKey);
    const provided = Buffer.from(providedKey);
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export type SepayWebhookPayload = {
  id: number;
  gateway: string;
  transactionDate: string;
  accountNumber: string;
  code: string | null;
  content: string;
  transferType: "in" | "out";
  transferAmount: number;
  accumulated: number;
  subAccount: string | null;
  referenceCode: string;
  description?: string;
};
