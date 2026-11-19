# 1. Immutable Master Vault & Sync Drop-Shield

Status: accepted

Ana Kasa (başlangıçta 1.867 şarkılık kök repertuar) aktif bulut yedeğinden ayrı bir sunucu deposunda tutulur ve varsayılan olarak kilitlidir; günlük düzenlemeler ve otomatik senkron bu kasayı değiştiremez. Sunucu, kalıcı orijinal 1.867 kök kopyaya ek olarak son 5 mühürlü sürümü saklar; yönetici bilinçli onayla yeni şarkılarla kasayı güncelleyip yeniden kilitleyebilir ve geri yükleme yaptığında yalnızca Repertuar yenilenirken mevcut Setlistler korunur.

Otomatik veya hatalı bir istemcinin tek seferde toplu şarkı kaybına yol açmasını önlemek için sunucu senkron uç noktasında düşüş kalkanı uygulanır: aktif Repertuar'da 50 veya daha fazla şarkı varken tek istekte 20'den fazla şarkı azaltan yazmalar `force: true` açık onayı olmadan HTTP 409 ile reddedilir.
