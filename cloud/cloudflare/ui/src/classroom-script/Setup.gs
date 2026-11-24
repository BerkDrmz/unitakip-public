// The installer deploys this page with MYSELF access and USER_ACCESSING execution.
function doGet() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  let message = 'İlk Classroom aktarımı tamamlandı. Takip saatte bir otomatik devam edecek.';
  try {
    startClassroom_(true);
  } catch {
    message = 'Classroom kurulumu tamamlanamadı. UniTakip’in açık olduğunu kontrol edip bu sayfayı yenile. Sorun sürerse Apps Script’te Yürütmeler bölümüne bak.';
  }
  return HtmlService.createHtmlOutput('<!doctype html><html lang="tr"><meta charset="utf-8"><main><h1>UniTakip Classroom</h1><p>' +
    message + '</p></main></html>').setTitle('UniTakip Classroom');
}
