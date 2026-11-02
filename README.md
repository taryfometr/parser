# parser

How taryfometr reads your file from eLicznik (TAURON Dystrybucja), in your browser.

`elicznik.js` reads the hourly report („Raporty” → „Raport godzinowy”, CSV) and keeps only each hour's kWh taken from
the grid and given back. **The payer number (Nr płatnika) and the PPE are dropped right here**: only a short hash of
them stays in the page, to tell two meters apart. The file itself is never sent.

What the page then sends to our server is one row per hour: `[day, hour, fold, kWh taken, kWh given]`, for the 12
months compared. You can see it yourself: open the browser's developer tools, tab „Network” (Sieć), and look at the
request to `/api/faktura`.

## Use

```html
<script src="elicznik.js"></script>
<script>
  const {rows, from, to, kinds, ids} = await elicznik.parseFile(file)
</script>
```

`rows`: `{day: 'YYYY-MM-DD', h: 0–23 (local, the hour starting then), fold: 1 for the hour that comes twice when the
clocks go back, kind: 'import' | 'export' | 'import_net' | 'export_net', kwh}`. eLicznik labels an hour by its end and
midnight as „00:00” of the next day; the parser turns that into the hour's start.
