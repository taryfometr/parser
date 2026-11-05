# parser

## 0.3.0 — 2026-11-05
- `faktura.js`: `mask(file)`, where an invoice holds personal data (name, address, PPE, customer, payer and account numbers, the transfer's details, the meter's and the invoice's numbers, QR and bar codes), to black it out in the browser

## 0.2.0 — 2026-11-03
- `faktura.js`: a TAURON invoice's numbers from its PDF, in the browser (pdf.js); pieces of text joined by their place on the page

## 0.1.0 — 2026-11-02
- the hourly report from eLicznik („Raporty”), CSV, UTF-8 or Windows-1250
- one column per energy or a „Rodzaj” column; „Data i godzina” together or apart
- hours labelled by their end, midnight as 00:00 of the next day; the clock changes
- the payer number and the PPE dropped, a hash kept to tell meters apart
