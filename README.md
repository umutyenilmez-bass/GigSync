# GigSync

Canlı performans yapan müzisyenler için gerçek zamanlı setlist senkronizasyon uygulaması. Lider sahneye çıkmadan önce setlisti hazırlar; performans sırasında hangi şarkıya geçtiğini seçer, tüm ekip üyelerinin telefonuna anında yansır.

---

## Özellikler

**Gerçek Zamanlı Senkronizasyon**
Lider şarkı seçtiği anda tüm üyelerin ekranı güncellenir. Aynı WiFi'da olmak şart değil, internet bağlantısı yeterli.

**Kütüphane Sistemi**
Tüm repertuar merkezi bir kütüphanede tutulur. Mekan veya proje bazında alt kütüphaneler oluşturulabilir (ör. Rixsos, Hilton, Jazz Set). Şarkılar kütüphaneler arasında tek dokunuşla veya toplu olarak aktarılabilir.

**Setlist Yönetimi**
İstenilen sayıda setlist oluşturulabilir. Her setlist kütüphaneden şarkı çekerek derlenir. Setlist sırasını sürükleyerek düzenlemek mümkündür.

**Toplu İçe Aktarma**
Şarkı listesini metin olarak yapıştırarak kütüphaneye toplu ekleyebilirsiniz. Ton (key) bilgisi otomatik algılanır.

**Oda Sistemi**
Her performans için 4 haneli bir oda kodu oluşturulur. Üyeler kodu girerek odaya katılır. Son katılınan odalar hatırlanır, tek dokunuşla tekrar katılınabilir.

**PWA**
Telefona ana ekrana eklenebilir, uygulama gibi açılır.

**Tema Seçenekleri**
Dark (varsayılan), Orange, Gold, Light ve Stage modları mevcuttur. Stage modu sahnede uzaktan okunabilmek için yazı boyutlarını büyütür.

---

## Nasıl Kullanılır

**Lider:**
1. "Lider olarak başla" → isim gir
2. Setlist oluştur, şarkıları kütüphaneden ekle
3. "Oda Aç" → oluşan kodu üyelerle paylaş
4. Şarkıya dokun → tüm üyelere gönderilir

**Üye:**
1. "Odaya katıl" → oda kodunu gir → isim yaz → Katıl
2. Liderin seçtiği şarkı ekranda büyük görünür, bir sonraki şarkı altta gösterilir

---

## Deploy (GitHub Pages)

1. GitHub'da yeni bir repo oluştur
2. Bu klasördeki dosyaları yükle
3. Settings → Pages → Branch: main → Save
4. Birkaç dakika sonra `https://kullaniciadi.github.io/repo-adi` adresinde yayında olur

---

## Teknoloji

- Vanilla HTML / CSS / JavaScript (framework yok)
- Supabase Realtime Database (gerçek zamanlı sync)
- PWA — Service Worker + Web App Manifest
