# GigSync

Önyüzün tamamı tek dosya: `index.html` (HTML + CSS + JS). `worker.js` yalnızca canlı senkron API'si (Cloudflare Worker + Durable Object). Terimler: [GLOSSARY.md](GLOSSARY.md). Mimari kararlar: `docs/adr/`.

## Arayüz

- Arayüz Türkçe ve sahnede telefondan okunur: **sade**. Ekranda yalnızca buton, başlık ve şarkı bilgisi durur. Açıklama cümlesi, boş liste mesajı, kullanıcı adı ya da durum rozeti gibi yeni bir görünür metin eklemeden önce kullanıcıya sor.
- Şarkı listelenen her yer aynı satır şablonunu kullanır: `songMainHtml(s)` (şarkı adı, altında sanatçı; mashupta `🔗 MASHUP` + parça adları) ve `songTagsHtml(s)` (Ton + BPM kutuları), `rep-edit-row` sınıflarıyla. Yeni bir liste de bu ikisiyle kurulur.
- Ana ekrandaki Mashuplar listesi Ton/BPM kutusu göstermez (kullanıcı tercihi).

## Veri, senkron, geri al

- Repertuar `S.libraries`, setlistler `S.setlists`. Kalıcı kayıt her zaman `saveLibraries()` / `saveSetlists()` üzerinden yapılır: bu ikisi buluta senkronu ve geri/ileri al geçmişini (`historyCapture`) besler. Veriyi değiştiren yeni kod da bunlardan geçer, böylece işlem geri alınabilir.
- Buluttan veri çeken kod sonunda `historyRebase()` çağırır; bulut güncellemesi bir geri alma adımı sayılmaz.
- Setlist silme `applySetlistDeletions` ile silinme kaydı bırakır; geri getirilen setliste `restoredAt` yazılır. Bu ikisi atlanırsa bulut senkronu silineni geri getirir ya da geri geleni yeniden siler.

## Doğrulama

Build ve test yok. `index.html` değişikliğinden sonra inline script sözdizimini kontrol et:

```bash
node -e "const h=require('fs').readFileSync('index.html','utf8');for(const m of h.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g))new (require('vm').Script)(m[1]);console.log('script syntax ok')"
```

`index.html` CRLF satır sonlu ve ~9000 satır; çok satırlı düzenlemede satır sonlarını koru.

## Yayın (canlıya alma)

- Önyüz: `main`'e push = GitHub Pages yayını → https://umutyenilmez-bass.github.io/GigSync/ (yaklaşık 1 dk). Push'tan önce kullanıcıdan onay al; sonra canlı sayfayı çekip yeni sürümü doğrula.
- Her önyüz sürümünde `sw.js` içindeki `CACHE` adını artır; telefonlardaki çevrimdışı kopya böyle yenilenir.
- Worker yalnızca `worker.js` değiştiyse `npx wrangler deploy` ile yayınlanır.
