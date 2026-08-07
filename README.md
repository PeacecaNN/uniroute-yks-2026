# UniRoute — Vercel Full-Stack

Bu sürümde Next.js arayüzü ve API aynı Vercel projesinde çalışır.

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

Yerel Google rota özellikleri için `.env.local` oluştur:

```env
GOOGLE_MAPS_API_KEY=AIza...
```

## Vercel

Ayrıntılı adımlar için `VERCEL-KURULUM.txt` dosyasını aç.
