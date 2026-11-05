// faktura.js: reads a TAURON invoice (PDF) in the browser and finds the numbers taryfometr asks for, so the customer
// does not have to copy them. Only those numbers are kept; the PDF itself, the name, the address, the PPE and the
// meter's number are not read out and nothing is sent. It needs pdf.js (window.pdfjsLib) on the page.
//
// fakturaTauron.read(file) → {found: {field: value}, missing: [field]}
//   period [from, to] ISO days, months (billing every n months), kind 'nb' | 'nm', reading 'ok' | 'est', kwh,
//   sale and total (zł with VAT: lines 1 and 3), dep (line 5: the deposit from before), tariff 'G11'…, code (the price
//   list), net [zł/kWh net per zone, in taryfometr's order], trade (zł/month net), fixed (the network's fixed fee, net)
//
// fakturaTauron.mask(file) → [{p, x, y, w, h, kind}]: where the invoice holds personal data, page by page (p from 0;
//   x, y from the page's top left, in PDF points), so the page can black it out before anything is shown. kind:
//   'osoba' (name and address), 'ppe' (the point of supply: its address and number), 'nr' (customer, payer, account
//   numbers), 'przelew' (the transfer's details), 'faktura' (the invoice's number), 'licznik' (the meter's number),
//   'kody' (QR and bar codes). By the invoice's layout and by what the numbers look like; whatever sits in the blocks
//   that hold the customer's data is covered, unless it is one of the few labels we know.
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

  // ---- personal data, to black out
  const KEEP_LABEL = /^(Data wystawienia|Okres rozliczeniowy|Częstotliwość rozliczenia|Rodzaj rozliczenia)$/;
  const CODE = /[^\x20-\x7E -ſ‐-…]/;     // a bar code or a QR printed with a font of its own
  const NUMBERS = [
    [/[A-Z]\/[A-Z0-9]+\/[A-Z0-9]+\/\d+\/\d+/, 'faktura'],    // T/K1/BC832817/0010/26
    [/\bS\d{9,}/, 'licznik'],                              // the meter's serial number
    [/PL[A-Z]{4}\d{6,}\w*|\b590\d{15}\b/, 'ppe'],          // the PPE: PLTAUD… or its 18 digits
    [/\b\d{2}(?: ?\d{4}){6}\b/, 'nr'],                     // a bank account (26 digits)
    [/\b\d{8,}\b/, 'nr'],                                  // a customer's or payer's number
    [/^[0-9a-f]{8,}$/, 'kody'],                            // a document's code
  ];

  let ruler = null;
  function width(s) {
    if (!ruler) { ruler = document.createElement('canvas').getContext('2d'); ruler.font = '10px Arial, Helvetica, sans-serif'; }
    return ruler.measureText(s).width;
  }

  async function pageItems(page) {
    const vp = page.getViewport({scale: 1});
    const items = (await page.getTextContent()).items.filter(i => i.str.trim()).map(i => {
      const t = pdfjsLib.Util.transform(vp.transform, i.transform), h = Math.hypot(t[2], t[3]);
      return {s: i.str, x: t[4], y: t[5] - h, w: i.width, h};
    }).filter((it, k, all) => all.findIndex(o => o.s === it.s && Math.abs(o.x - it.x) < 1 && Math.abs(o.y - it.y) < 1) === k);
    const lines = [];
    for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const L = lines.find(l => Math.abs(l.y - it.y) < it.h * 0.5);
      if (L) L.parts.push(it); else lines.push({y: it.y, h: it.h, parts: [it]});
    }
    for (const L of lines) {
      L.parts.sort((a, b) => a.x - b.x);
      L.text = L.parts.map((q, k) => (k && q.x - (L.parts[k - 1].x + L.parts[k - 1].w) > q.h * 0.15 ? ' ' : '') + q.s).join('').replace(/\s+/g, ' ').trim();
    }
    return {w: vp.width, h: vp.height, items, lines};
  }

  async function mask(file) {
    const pdf = await pdfjsLib.getDocument({data: await file.arrayBuffer()}).promise;
    const out = [];
    for (let p = 0; p < pdf.numPages; p++) {
      const {items, lines} = await pageItems(await pdf.getPage(p + 1));
      const got = new Set();
      const add = (it, kind, from = 0, to = it.s.length) => {
        got.add(it);
        // within a piece, where the characters fall is only estimated: a character to spare each side, to its end on the right
        // (measured in a sans-serif like the invoice's: letters are not all as wide)
        const at = n => it.x + it.w * width(it.s.slice(0, n)) / Math.max(width(it.s), 1), cw = it.w / Math.max(it.s.length, 1);
        const x0 = from ? at(from) - cw : it.x, x1 = to >= it.s.length ? it.x + it.w : at(to) + cw;
        out.push({p, x: x0 - 2, y: it.y - 2, w: x1 - x0 + 4, h: it.h + 4, kind});
      };
      const find = re => lines.find(l => re.test(l.text));
      const between = (a, b) => items.filter(it => (!a || it.y >= a.y + a.h - 1) && (!b || it.y + it.h <= b.y + 1));
      const all = lines.map(l => l.text).join('\n');

      // what the numbers look like, anywhere
      for (const it of items) {
        if (CODE.test(it.s)) { add(it, 'kody'); continue; }
        for (const [re, kind] of NUMBERS) { const m = it.s.match(re); if (m) { add(it, kind, m.index, m.index + m[0].length); break; } }
      }
      // the summary: under its title the customer (left) and their numbers (right), around the four labels we read
      const title = find(/podsumowanie Twojej faktury/), energy = find(/^Ilość energii/);
      if (title) {
        // the left column line by line (pdf.js cuts a label into pieces at its Polish letters): a label and the line under it
        const zone = new Set(between(title, energy)), keep = new Set();
        const left = lines.map(l => l.parts.filter(it => it.x < 200 && zone.has(it))).filter(ps => ps.length)
          .map(ps => ({ps, text: ps.map((q, k) => (k && q.x - (ps[k - 1].x + ps[k - 1].w) > q.h * 0.15 ? ' ' : '') + q.s).join('').trim()}));
        left.forEach((L, k) => { if (KEEP_LABEL.test(L.text)) [L, left[k + 1]].forEach(x => x && x.ps.forEach(it => keep.add(it))); });
        for (const it of between(title, energy)) if (!keep.has(it) && !got.has(it)) add(it, it.x < 200 ? 'osoba' : 'nr');
        // paying: the transfer's box on the left (the customer's own account, their name)
        const how = find(/Wybierz metodę płatności/), foot = find(/^Masz pytania/), app = items.find(it => /^Zapłać przez/.test(it.s));
        if (how) for (const it of between(how, foot)) if (!got.has(it) && it.x < (app ? app.x - 25 : 220)) add(it, 'przelew');
      }
      // the invoice: under the seller the buyer and their numbers; the point of supply under its title
      const seller = find(/^Sprzedawca\b/), settle = find(/^Twoje rozliczenie/);
      if (seller && /To jest Twoja faktura/.test(all)) {
        const keep = new Set(seller.parts);
        for (const L of lines.filter(l => l.y > seller.y).sort((a, b) => a.y - b.y)) {
          const mine = L.parts.filter(it => it.x < 200);
          mine.forEach(it => keep.add(it));
          if (mine.some(it => /\d{2}-\d{3}/.test(it.s))) break;   // the seller's postcode ends its address
        }
        for (const it of between(seller, settle)) if (!keep.has(it) && !got.has(it)) add(it, it.x < 200 ? 'nr' : 'osoba');
      }
      const ppe = find(/^Informacje dotyczące umowy i licznika/), group = find(/^Grupa taryfowa/);
      if (ppe && group) for (const it of between(ppe, group)) if (!got.has(it)) add(it, 'ppe');
      // a transfer slip: all of it
      if (!title && !seller && /Nazwa odbiorcy|Nr rachunku|Numer rachunku|Polecenie przelewu|Wpłata gotówkowa|Tytułem/i.test(all)) for (const it of items) if (!got.has(it)) add(it, 'przelew');
    }
    // the pieces of one line and one kind side by side: one bar
    out.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
    const bars = [];
    for (const r of out) {
      const b = bars.find(o => o.p === r.p && o.kind === r.kind && Math.abs(o.y - r.y) < 3 && r.x - (o.x + o.w) < 14 && r.x + r.w > o.x - 14);
      if (b) { const x1 = Math.max(b.x + b.w, r.x + r.w), y1 = Math.max(b.y + b.h, r.y + r.h); b.x = Math.min(b.x, r.x); b.y = Math.min(b.y, r.y); b.w = x1 - b.x; b.h = y1 - b.y; }
      else bars.push({...r});
    }
    // a code printed as rows of glyphs: one block
    for (let k = bars.length - 1; k >= 0; k--) {
      const r = bars[k]; if (r.kind !== 'kody') continue;
      const b = bars.find(o => o !== r && o.p === r.p && o.kind === 'kody' && r.y <= o.y + o.h + 2 && o.y <= r.y + r.h + 2 && r.x <= o.x + o.w + 2 && o.x <= r.x + r.w + 2);
      if (b) { const x1 = Math.max(b.x + b.w, r.x + r.w), y1 = Math.max(b.y + b.h, r.y + r.h); b.x = Math.min(b.x, r.x); b.y = Math.min(b.y, r.y); b.w = x1 - b.x; b.h = y1 - b.y; bars.splice(k, 1); }
    }
    return bars;
  }

  window.fakturaTauron = {read, mask};
})();
