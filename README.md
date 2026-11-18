# ✈️🏖️ Hlídač levných letenek z Prahy a zájezdů z ČR

Sám 6× denně prohledá nejlevnější lety z Prahy kamkoli (6 měsíců dopředu), pozná podezřele levné ceny („chyby v cenách“)
a pošle push do mobilu (ntfy) a e-mail (Resend). Přehled: **https://fandaverner.github.io/letenky/**

## Nastavení (jednorázově)
1. **Settings → Pages → Source: GitHub Actions**
2. **Settings → Secrets and variables → Actions → New repository secret**:
   - `TRAVELPAYOUTS_TOKEN` – API token z travelpayouts.com (program Aviasales)
   - `NTFY_TOPIC` – tajné téma, ke kterému se přihlásíš v appce ntfy
   - `RESEND_API_KEY` – klíč z resend.com
   - `ALERT_EMAIL` – kam posílat e-maily (stejný, se kterým ses registroval na Resend)
3. **Actions → Hledat letenky → Run workflow**

Hranice „super ceny“ a „chyby v ceně“ se mění v `config.json` (zájezdy v části `tours`).

**Zájezdy:** 3× denně (7, 15 a 19 h) čte last minute nabídky CK Čedok a Blue Style (`scripts/tours.mjs`), hlídá slevy, cenu za noc a zlevnění konkrétních termínů.

## Jak to funguje
- `.github/workflows/scan.yml` – spouští hledání (2:07, 6:07, 10:07, 14:07, 18:07, 22:07 UTC), ukládá data a publikuje web
- `scripts/scan.mjs` – stahuje ceny (Travelpayouts/Aviasales Data API), vyhodnocuje, posílá upozornění
- `site/` – web s přehledem, `site/data/` – aktuální nabídky a historie cen
