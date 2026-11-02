// elicznik.js: reads the hourly report from TAURON Dystrybucja's eLicznik („Raporty” → „Raport godzinowy”, CSV) in the
// browser and keeps only what the simulation needs: each hour's kWh taken and given back. The payer number and the
// PPE are dropped here: only a short hash of them stays in the page, to tell two meters apart. Nothing is sent.
//
// elicznik.parseFile(file) → {rows: [{day, h, fold, kind, kwh}], from, to, kinds: Set, ids: bool, point}
//   day 'YYYY-MM-DD' and h 0–23 local, the hour starting then; fold 1 for the hour that comes twice when the clocks go
//   back; kind 'import' | 'export' | 'import_net' | 'export_net' (the last two after TAURON balances the phases).
(function () {
  async function decode(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', {fatal: true}).decode(buf); }
    catch { return new TextDecoder('windows-1250').decode(buf); }
  }

  function kindOf(t) {
    t = t.toLowerCase();
    const dir = /pob/.test(t) ? 'import' : /odd/.test(t) ? 'export' : null;
    if (!dir) return null;
    return /zbilans|bilans|netto/.test(t) ? dir + '_net' : dir;
  }

  async function parseFile(file) {
    if (/\.(xlsx?|pdf)$/i.test(file.name)) throw new Error('To nie jest plik CSV. W eLiczniku wybierz format CSV i pobierz raport jeszcze raz.');
    const text = (await decode(file)).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const sample = lines.slice(0, 5).join('\n');
    const delim = [';', '\t', ','].sort((a, b) => sample.split(b).length - sample.split(a).length)[0];
    const split = l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const hi = lines.findIndex(l => split(l).some(c => /^(data|czas)/i.test(c)));
    if (hi < 0) throw new Error('Nie widzę tu danych godzinowych z eLicznika. Pobierz „Raport godzinowy” z zakładki „Raporty”.');
    const head = split(lines[hi]);
    const col = re => head.findIndex(h => re.test(h));
    const date = col(/^(data|czas)/i), hour = head.findIndex((h, i) => /godzin/i.test(h) && i !== date), kind = col(/^(rodzaj|typ|kierunek)/i), value = col(/warto/i);
    const idCols = head.map((h, i) => /płatnik|platnik|ppe|punkt|licznik|numer|^nr\b/i.test(h) && i !== date ? i : -1).filter(i => i >= 0);
    const wide = head.map((h, i) => [i, kindOf(h)]).filter(([i, k]) => k && !idCols.includes(i) && i !== kind);
    if (!(kind >= 0 && value >= 0) && !wide.length) throw new Error('Nie rozpoznaję kolumn z energią. Zaznacz w raporcie energię pobraną (i oddaną, jeśli masz panele).');

    const raw = [], idVals = new Set();
    let maxLabel = 0, minLabel = 99;
    for (const l of lines.slice(hi + 1)) {
      const c = split(l);
      const d = c[date] || '';
      let m = d.match(/(\d{4})-(\d{2})-(\d{2})/), day;
      if (m) day = `${m[1]}-${m[2]}-${m[3]}`;
      else if ((m = d.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/))) day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      else continue;
      const hs = hour >= 0 ? c[hour] : d.replace(/^\S+\s*/, '');
      let h, range = false;
      if ((m = hs.match(/(\d{1,2}):\d{2}\s*[-–]\s*\d{1,2}:\d{2}/))) { h = +m[1]; range = true; }
      else if ((m = hs.match(/^(\d{1,2})(?::\d{2})?/))) { h = +m[1]; maxLabel = Math.max(maxLabel, h); minLabel = Math.min(minLabel, h); }
      else continue;
      idCols.forEach(i => c[i] && idVals.add(c[i]));
      const vals = kind >= 0 && value >= 0 ? [[kindOf(c[kind] || ''), c[value]]] : wide.map(([i, k]) => [k, c[i]]);
      for (const [k, v] of vals) {
        const kwh = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
        if (k && !isNaN(kwh)) raw.push({day, h, range, kind: k, kwh});
      }
    }
    if (!raw.length) throw new Error('Plik nie ma żadnych godzin z wartościami.');
    // eLicznik labels an hour by its end: "01:00" is 00:00–01:00, and midnight is either "24:00" of that day or
    // "00:00" of the next. The night the clocks go forward tells which: an end label skips "03:00", a start one "02:00".
    // A range "00:00-01:00" names its start.
    const spring = new Map();
    for (const r of raw) if (!r.range && r.day.slice(5, 7) === '03') (spring.get(r.day) || spring.set(r.day, new Set()).get(r.day)).add(r.h);
    const short = [...spring.values()].find(set => set.size === 23);
    const byEnd = !(short && minLabel === 0 && !short.has(2));
    const prev = day => new Date(Date.parse(day + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
    const seen = new Set(), rows = [];
    for (const r0 of raw) {
      const r = !r0.range && byEnd && r0.h === 0 ? {...r0, day: prev(r0.day), h: 24} : r0;
      const h = r.range ? r.h : byEnd ? r.h - 1 : r.h;
      if (h < 0 || h > 23) continue;
      let fold = 0, key = `${r.day}|${h}|${r.kind}`;
      if (seen.has(key)) { fold = 1; key += '|1'; }   // the hour that comes twice when the clocks go back
      seen.add(key);
      rows.push({day: r.day, h, fold, kind: r.kind, kwh: r.kwh});
    }
    const days = rows.map(r => r.day).sort();
    const point = idVals.size ? await hash([...idVals].sort().join('|')) : '';
    return {rows, from: days[0], to: days[days.length - 1], kinds: new Set(rows.map(r => r.kind)), ids: idCols.length > 0, point};
  }

  async function hash(s) {   // only to tell two meters apart; the hash stays in the page too
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].slice(0, 6).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  window.elicznik = {parseFile};
})();
