// faktura.js: reads a TAURON invoice (PDF) in the browser and finds the numbers taryfometr asks for, so the customer
// does not have to copy them. Only those numbers are kept; the PDF itself, the name, the address, the PPE and the
// meter's number are not read out and nothing is sent. It needs pdf.js (window.pdfjsLib) on the page.
//
// fakturaTauron.read(file) → {found: {field: value}, missing: [field]}
//   period [from, to] ISO days, months (billing every n months), kind 'nb' | 'nm', reading 'ok' | 'est', kwh,
//   sale and total (zł with VAT: lines 1 and 3), dep (line 5: the deposit from before), tariff 'G11'…, code (the price
//   list), net [zł/kWh net per zone, in taryfometr's order], trade (zł/month net), fixed (the network's fixed fee, net)
(function () {
  const FIELDS = ['period', 'months', 'kind', 'reading', 'kwh', 'sale', 'total', 'dep', 'tariff', 'code', 'net', 'trade', 'fixed'];
  const ORDER = {G11: ['all'], G12: ['day', 'night'], G12w: ['day', 'night'], G13: ['am', 'pm', 'off']};
  const num = s => parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  const iso = d => d.split('.').reverse().join('-');
  const AMOUNT = '(\\d[\\d ]*,\\d{2})';

  async function text(file) {
    const pdf = await pdfjsLib.getDocument({data: await file.arrayBuffer()}).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      // pdf.js splits words where the font changes, as at a Polish letter („Sprzeda” „ż”): a space only where the
      // next piece starts after a gap on the same line
      let out = '', prev = null;
      for (const it of c.items) {
        const x = it.transform[4], y = it.transform[5], size = Math.hypot(it.transform[0], it.transform[1]) || 10;
        if (prev && !/\n$/.test(out)) {
          const sameLine = Math.abs(y - prev.y) < size * 0.3, gap = x - prev.end;
          out += sameLine && gap < size * 0.15 ? '' : ' ';
        }
        out += it.str + (it.hasEOL ? '\n' : '');
        prev = {y, end: x + it.width};
      }
      pages.push(out);
    }
    return pages.join('\n').replace(/[ \t]+/g, ' ');
  }

  // the zone a line of „Energia czynna” prices, in the invoice's words
  function zoneOf(name) {
    const n = name.toLowerCase();
    if (/całodob/.test(n)) return 'all';
    if (/przedpołud/.test(n)) return 'am';
    if (/popołud/.test(n)) return 'pm';
    if (/pozostał/.test(n)) return 'off';
    if (/noc|pozaszczyt/.test(n)) return 'night';
    if (/dzien|dzień|szczyt/.test(n)) return 'day';
    return null;
  }

  async function read(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('To nie jest plik PDF.');
    const t = await text(file);
    if (!/TAURON/i.test(t)) throw new Error('To nie wygląda na fakturę TAURON.');
    const f = {};
    let m;
    if ((m = t.match(/Okres rozliczeniowy\s+(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/))) f.period = [iso(m[1]), iso(m[2])];
    if ((m = t.match(/Częstotliwość rozliczenia\s+Co\s+(\d+)\s+miesi/i))) f.months = +m[1];
    if ((m = t.match(/Rodzaj rozliczenia\s+(Net[- ]?billing|Net[- ]?metering)/i))) f.kind = /billing/i.test(m[1]) ? 'nb' : 'nm';
    if ((m = t.match(/\((Zdalny|Fizyczny|Odbiorcy|Szacunkowy)\)/) || t.match(/Odczyt\s+(Zdalny|Fizyczny|Odbiorcy|Szacunkowy)/i)))
      f.reading = /szacunk/i.test(m[1]) ? 'est' : 'ok';
    if ((m = t.match(new RegExp('1\\.\\s*Sprzedaż energii elektrycznej\\s+(\\d[\\d ]*)\\s+' + AMOUNT + '\\s+23\\s+' + AMOUNT + '\\s+' + AMOUNT)))) {
      f.kwh = num(m[1]); f.sale = num(m[4]);
    }
    if ((m = t.match(new RegExp('3\\.\\s*Wynik rozliczenia \\(1\\+2\\)\\s+' + AMOUNT + '\\s+23\\s+' + AMOUNT + '\\s+' + AMOUNT)))) f.total = num(m[3]);
    if ((m = t.match(new RegExp('5\\.\\s*Depozyt prosumencki z okresów poprzednich \\(zł\\)\\s+' + AMOUNT)))) f.dep = num(m[1]);
    if ((m = t.match(/Grupa taryfowa\s+(G1[123]w?)\b/))) f.tariff = m[1];
    if ((m = t.match(/Twój cennik\s+([^\n]+?)\s*(?:\n|Moc umowna|Rodzaj rozliczenia|$)/))) f.code = m[1].trim();
    // „Energia czynna”: the first block of zone lines, before „Opłata Handlowa” (distribution repeats the zone names)
    const sale = t.split(/Opłata Handlowa/i)[0].split(/Energia czynna/i).slice(-1)[0];
    const prices = {};
    for (const z of sale.matchAll(/([A-Za-zżźćńółęąśŻŹĆŃÓŁĘĄŚ ]+?)\s+\d[\d ]*\s+kWh\s+(\d+,\d+)/g)) {
      const k = zoneOf(z[1]);
      if (k && !(k in prices)) prices[k] = num(z[2]);
    }
    if (f.tariff && ORDER[f.tariff].every(k => k in prices)) f.net = ORDER[f.tariff].map(k => prices[k]);
    if ((m = t.match(/Opłata Handlowa\s+\d+\s+mc\s+(\d+,\d+)/i))) f.trade = num(m[1]);
    if ((m = t.match(/Składnik stały stawki sieciowej\s+\d+\s+mc\s+(\d+,\d+)/i))) f.fixed = num(m[1]);
    return {found: f, missing: FIELDS.filter(k => !(k in f))};
  }

  window.fakturaTauron = {read};
})();
