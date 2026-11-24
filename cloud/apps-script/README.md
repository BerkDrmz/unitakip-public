# Apps Script alternatifi — etkin olmayan taslak

Bu klasör, kart gerektirmeyen ayrı bir bulut çalışma ortamı için hazırlanmış **deneysel taslaktır**.
Mevcut Python uygulaması bu kodu kullanmaz. Hiçbir Google hesabına yüklenmedi; oturum bilgileri
aktarılmadı, tetikleyici kurulmadı ve bu sürümden e-posta gönderilmedi.

`npm ci` ve `npm run build` ile Apps Script paketi üretilebilir. Derleme kontrolü yapıldı;
Google ortamında gerçek çalıştırma, regresyon testleri, kota ölçümü ve güvenlik incelemesi
tamamlanmadan üretimde kullanılmamalıdır. Python projesindeki test sayısı bu sürümü kapsamaz.

Kullanıcının güncel tercihi mevcut uygulamayı doğrudan barındırabilecek seçenekleri incelemektir.
Apps Script uyarlaması otomatik olarak seçilmemeli veya kurulmuş gibi raporlanmamalıdır.
