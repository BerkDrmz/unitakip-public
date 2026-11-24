// Panel API istemcisi. Sözleşme Worker'daki src/panel.js ve src/panel-auth.js ile aynıdır.
export const ERROR = {
  classroom_setup: "Classroom için Google Cloud kurulumu gerekiyor.",
  unauthorized: "Oturumun sona erdi. Yeniden giriş yapabilirsin.",
  cooldown: "Yeni kod istemeden önce biraz beklemelisin.",
  rate_limit: "Çok fazla kod istendi. Bir süre sonra yeniden dene.",
  invalid_code: "Kod doğru görünmüyor. Altı haneli kodu kontrol et.",
  code_expired: "Kodun süresi dolmuş veya kullanılmış. Yeni bir kod iste.",
  mail: "E-posta şu anda gönderilemedi. Biraz sonra yeniden dene.",
  busy: "Bir kontrol sürüyor. Tamamlanınca yeniden deneyebilirsin.",
  paused: "Önce takibi yeniden başlatmalısın.",
  disabled: "Takip şu anda kullanılamıyor.",
  setup: "İlk kurulumun tamamlanması gerekiyor.",
  config: "Site bilgileri geçersiz. Adresi ve bağlantı türünü kontrol et.",
  bad_request: "İstek okunamadı. Sayfayı yenileyip yeniden dene.",
};

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Sunucuya şu anda ulaşılamıyor. Biraz sonra yeniden dene.");
  }
  if (!response.ok) {
    const error = new Error(
      (data.error === "config" && data.message) || ERROR[data.error] || "Bağlantı kurulamadı. Lütfen yeniden dene.",
    );
    error.code = data.error;
    error.retryAfter = data.retryAfter;
    throw error;
  }
  return data;
}

export const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
