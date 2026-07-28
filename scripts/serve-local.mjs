import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const cencoDir = path.join(
  rootDir,
  "projects",
  "cencomall",
  "Assets",
  "StreamingAssets",
  "sima_services"
);

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".mjs": "text/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf"
};

function generateHubIndex() {
  const pages = [
    { title: "Mapa MapVX (Cenco Costanera)", path: "/map/index.html", icon: "🗺️" },
    { title: "Catálogo de Servicios", path: "/servicios/index.html", icon: "🛍️" },
    { title: "Promociones", path: "/promociones/index.html", icon: "🏷️" },
    { title: "Promociones (Preview)", path: "/promociones-preview.html", icon: "👀" },
    { title: "Taxis", path: "/taxi/index.html", icon: "🚕" },
    { title: "Emergencias", path: "/emergency/index.html", icon: "🚨" },
    { title: "Vuelos", path: "/flights/index.html", icon: "✈️" },
    { title: "Atención Humana", path: "/human/index.html", icon: "👤" },
    { title: "Movilidad", path: "/mobility/index.html", icon: "🛴" },
    { title: "Agenda", path: "/agenda/index.html", icon: "📅" },
    { title: "Llamada Directa", path: "/call/index.html", icon: "📞" },
    { title: "Servicios 2", path: "/services-2/index.html", icon: "⚙️" }
  ];

  const listItems = pages
    .map(
      (page) => `
        <a href="${page.path}" class="card">
          <span class="icon">${page.icon}</span>
          <div class="info">
            <div class="title">${page.title}</div>
            <div class="path"><code>${page.path}</code></div>
          </div>
        </a>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SIMA HTML Hub - Local Server (Cencomall)</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-hover: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.15);
      --border: #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 2rem 1rem;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      max-width: 840px;
      width: 100%;
    }
    header {
      margin-bottom: 2rem;
      text-align: center;
    }
    h1 {
      font-size: 2.2rem;
      font-weight: 800;
      background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    p.subtitle {
      color: var(--muted);
      font-size: 1rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 1rem;
    }
    .card {
      display: flex;
      align-items: center;
      gap: 1rem;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.2rem;
      text-decoration: none;
      color: var(--text);
      transition: all 0.2s ease;
    }
    .card:hover {
      background: var(--card-hover);
      border-color: var(--accent);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px var(--accent-glow);
    }
    .icon {
      font-size: 2rem;
      line-height: 1;
    }
    .info {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .title {
      font-weight: 600;
      font-size: 1.05rem;
    }
    .path code {
      font-size: 0.82rem;
      color: var(--accent);
      background: rgba(56, 189, 248, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
    }
    footer {
      margin-top: 3rem;
      text-align: center;
      color: var(--muted);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Cencomall HTML Hub</h1>
      <p class="subtitle">Servidor local activo para visualizar las pantallas HTML de Cencomall</p>
    </header>
    <main class="grid">
      ${listItems}
    </main>
    <footer>
      <p>Servidor local corriendo desde <code>projects/cencomall/Assets/StreamingAssets/sima_services</code></p>
    </footer>
  </div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let reqPath = decodeURIComponent(req.url.split("?")[0]);

  if (reqPath === "/" || reqPath === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
    res.end(generateHubIndex());
    return;
  }

  let filePath = path.join(cencoDir, reqPath);

  // Security check: prevent path traversal out of cencoDir
  if (!filePath.startsWith(cencoDir)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Check if it's a directory with index.html
      if (stats && stats.isDirectory()) {
        const indexPath = path.join(filePath, "index.html");
        if (fs.existsSync(indexPath)) {
          filePath = indexPath;
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 Not Found");
          return;
        }
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("500 Internal Server Error");
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Servidor local levantado con éxito para Cencomall!`);
  console.log(`🔗 Dashboard principal: http://localhost:${PORT}/`);
  console.log(`🗺️  Mapa:              http://localhost:${PORT}/map/index.html`);
  console.log(`🛍️  Servicios:         http://localhost:${PORT}/servicios/index.html`);
  console.log(`🏷️  Promociones:       http://localhost:${PORT}/promociones/index.html\n`);
});
