# GigSync — Canlı Sahne Setlist Senkronizasyonu

Canlı performans yapan müzisyenler için gerçek zamanlı, sıfır gecikmeli setlist senkronizasyon uygulaması. Lider sahneye çıkmadan önce setlisti hazırlar; performans sırasında hangi şarkıya geçtiğini seçer, tüm ekip üyelerinin telefonuna **10 ms içinde** yansır.

Sistem tamamen **Cloudflare Worker & Durable Objects (WebSocket Hibernation)** altyapısına taşınmıştır. **Asla uyumaz (sıfır pause)**, soğuk başlatma (cold start) derdi yoktur ve sahne koşullarında kesintisiz çalışır.

---

## Özellikler

- **Sıfır Pause & Ultra Hızlı Canlı Senkronizasyon (<10 ms):**
  Lider şarkı seçtiğinde Cloudflare Worker üzerindeki WebSocket omurgası tüm bağlı müzisyenlerin ekranını anında günceller.
- **Ekran Kilidi Açılınca Anında Reconnect:**
  Müzisyenin telefonu uyku moduna geçse veya ekran kilidi kapansa dahi, ekran açıldığı anda (`visibilitychange` / `online`) WebSocket otomatik bağlanır ve milisaniyeler içinde güncel şarkıyı ekrana yansıtır.
- **Kütüphane & Çoklu Setlist Yönetimi:**
  Tüm repertuar merkezi kütüphanede saklanır. Mekan veya proje bazında alt kütüphaneler oluşturulabilir. Sürükle-bırak ile şarkı sıralaması anlık güncellenir.
- **Toplu İçe Aktarma ("Toplu İçe Aktar"):**
  Şarkı listesini metin olarak yapıştırarak kütüphaneye toplu ekleyebilirsiniz. Müzikal ton (key) bilgisi otomatik algılanır.
- **Oda & Katılım Sistemi:**
  Her performans için 4 haneli benzersiz bir oda kodu oluşturulur. Son katılınan odalar yerel hafızada saklanır, tek dokunuşla yeniden katılınabilir.
- **PWA Uyumluluğu:**
  iOS ve Android cihazlarda ana ekrana eklenebilir, tam ekran yerel uygulama hissi verir.
- **Sahne Dostu Koyu Tema (Stage Mode):**
  Karanlık sahne ortamında gözü yormayan yüksek kontrastlı temalar ve uzaktan rahatça okunabilen devasa tipografi ("⚡ STAGE MODE").

---

## Nasıl Kullanılır

### Lider:
1. **"Lider Olarak Başla"** → İsim girin.
2. Setlist oluşturun ve şarkıları kütüphaneden veya toplu ekleme ile listeye ekleyin.
3. **"Oda Aç"** butonuna dokunun → Üretilen 4 haneli kodu ekiple paylaşın.
4. Çalınan şarkıya dokunun → Anında tüm ekip üyelerinin ekranı değişsin!

### Müzisyen / Ekip:
1. **"Odaya Katıl"** → 4 haneli oda kodunu ve adınızı girip Katıl'a dokunun.
2. Liderin seçtiği şarkı ekranda dev harflerle belirir, ton (key), tempo (BPM) ve sıradaki şarkı canlı olarak senkronize kalır.

---

## Dağıtım ve Kurulum

### 1. Cloudflare Worker Dağıtımı (`worker.js` & `wrangler.toml`)
Sistemin canlı senkronizasyon motorunu Cloudflare hesabınıza tek komutla yükleyin:

```bash
# Bağımlılık gerektirmez, doğrudan Wrangler ile dağıtılır:
npx wrangler deploy
```

Dağıtım tamamlandığında size `https://gigsync.<subdomain>.workers.dev` şeklinde bir Worker URL'i verilir.

### 2. Ön Yüz Dağıtımı (`index.html`)
Ön yüzü dilediğiniz yerde barındırabilirsiniz:
- **Cloudflare Pages / GitHub Pages / Vercel:** Dosyaları reponuza yükleyip GitHub Pages'i açın.
- **Uygulama İçi Ayarlar:** Sağ üstteki Ayarlar çarkına dokunarak **Cloudflare Senkron Sunucusu** alanına dağıttığınız Worker adresinizi girebilirsiniz. Varsayılan olarak doğrudan Worker alan adı ile eşleşir.

---

## Teknoloji Altyapısı

- **Backend / Realtime:** Cloudflare Worker (Durable Objects, WebSocket Hibernation API, REST API)
- **Frontend:** Vanilla HTML5, CSS3, Modern JavaScript (Sıfır bağımlılık, sıfır bundle boyutu)
- **Offline / PWA:** Service Worker (`sw.js`) ve Web App Manifest (`manifest.json`)
- **Protokol:** WebSockets (Duplex Realtime) + HTTP REST (Fail-safe Fallback)
