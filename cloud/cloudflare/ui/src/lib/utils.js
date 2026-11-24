import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui kuralı: koşullu sınıfları birleştir, çakışan Tailwind sınıflarını ayıkla. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
