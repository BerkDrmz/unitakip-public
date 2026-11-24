// Sayfa çizilmeden önce kayıtlı temayı uygular (yanlış temada parlama olmasın).
// CSP satır içi betiğe izin vermediği için ayrı dosya: script-src 'self'.
(function () {
  try {
    var mode = localStorage.getItem("unitakip-theme");
    if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  } catch (e) {}
})();
