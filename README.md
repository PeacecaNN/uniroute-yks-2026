# UniRoute — V2 Beta

Bu uygulama sayesinde Üniversite tercihlerinizi yaparken fazlasıyla yer, konum, puan vb şeyleri kolay şekilde görüp seçeceğiniz konumdan nasıl gideceğiniz, hangi ulaşım araçlarını kullanacağınız yazar.

## Yapı

- `app/page.tsx`: kullanıcı arayüzü
- `app/api/[[...path]]/route.js`: bütün API yolları
- `lib/api-core.js`: üniversite araması, Places, Geocoding ve Routes işlemleri
- `data/universite.csv`: üniversite program verileri

## Yerel çalıştırma

```powershell
npm.cmd install
npm.cmd run dev
```

Site: `http://localhost:3000`
API: `http://localhost:3000/api`

