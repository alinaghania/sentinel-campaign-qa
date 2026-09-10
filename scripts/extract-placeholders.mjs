// One-shot : régénère le vocabulaire de placeholders depuis le template vierge.
// Usage : node scripts/extract-placeholders.mjs
// Copier/coller la sortie dans lib/brief-placeholders.ts (PLACEHOLDER_TEXTS)
// après filtrage manuel (retirer codes langue, dates, mots d'en-tête).
import * as XLSX from "xlsx";

const wb = XLSX.readFile("lib/__tests__/fixtures/blank-template.xlsm");
const texts = new Set();
const urls = new Set();
for (const name of ["Campaign Brief", "EMAIL", "SMS", "VMS", "MMS", "LINE", "KKT", "WECHAT", "TASK", "WHATSAPP"]) {
  const ws = wb.Sheets[name];
  if (!ws) continue;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
  for (const row of rows) {
    for (let c = 2; c < (row?.length ?? 0); c++) {
      const v = String(row[c] ?? "").trim();
      if (!v || v.length > 120) continue;
      if (/^https?:/i.test(v)) urls.add(v.toLowerCase());
      else texts.add(v.replace(/\s+/g, " ").toLowerCase());
    }
  }
}
console.log("TEXTS:", JSON.stringify([...texts].sort(), null, 2));
console.log("URLS:", JSON.stringify([...urls].sort(), null, 2));
