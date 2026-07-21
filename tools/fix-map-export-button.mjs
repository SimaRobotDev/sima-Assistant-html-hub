import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const mapHtml = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../projects/cencomall/Assets/StreamingAssets/sima_services/map/index.html"
);

const buf = readFileSync(mapHtml);
let text = buf.toString("utf16le");
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

const re =
  /<button type="button" onclick="runMatchBathroomCatalog\(\)"[\s\S]*?Exportar patches JSON<\/button>>Cruzar cat[^<]*<\/button>/;
const replacement = `<button type="button" onclick="runMatchBathroomCatalog()">Cruzar catálogo ↔ POI</button>
      <button type="button" onclick="exportBathroomMapvxPatches()">Exportar patches JSON</button>`;

if (!re.test(text)) {
  if (text.includes('runMatchBathroomCatalog()">Cruzar') && text.includes("exportBathroomMapvxPatches")) {
    console.log("buttons already OK");
    process.exit(0);
  }
  console.error("could not locate broken button block");
  process.exit(1);
}

text = text.replace(re, replacement);
writeFileSync(mapHtml, Buffer.from("\ufeff" + text, "utf16le"));
console.log("fixed button row");
