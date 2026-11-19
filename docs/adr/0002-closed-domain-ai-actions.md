# 2. Closed-Domain AI Actions with Execution Approval

Status: accepted

AI asistanı yalnızca 4 GigSync modülü (Repertuar, Setlistler, Canlı Sahne, Ayarlar) içindeki 13 tanımlı resmi aksiyon kataloğuyla sınırlandırılmıştır; sunucu yanıtı beyaz liste ile doğrular, istemci ise referans verilen şarkı/setlist/üye/tema hedeflerini gerçek veride kontrol etmeden uydurma işlem uygulamaz. GigSync alanı dışındaki her istek herhangi bir aksiyon bloğu üretmeden sabit ret yanıtıyla reddedilir.

Canlı sahnede hız kritik olduğu için `STAGE_SELECT_SONG` ve `STAGE_OPEN` komutları doğrulandıktan sonra anında çalıştırılır; veri değiştiren, silen, Ana Kasa'yı mühürleyen/geri yükleyen, sahneyi kapatan veya üye çıkaran diğer tüm 11 aksiyon önce tek dokunuşluk "Onayla ve Uygula" özet kartı gerektirir.
