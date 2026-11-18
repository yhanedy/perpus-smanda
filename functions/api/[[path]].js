async function tursoQuery(env, statements) {
  const rawUrl = env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, "https://");
  const token = env.TURSO_AUTH_TOKEN;

  const requests = statements.map((stmt) => ({
    type: "execute",
    stmt: typeof stmt === "string" ? { sql: stmt } : stmt,
  }));
  requests.push({ type: "close" });

  const res = await fetch(`${rawUrl}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) throw new Error(`Turso Error (${res.status}): ${await res.text()}`);

  const data = await res.json();
  return data.results.map((r) => {
    if (r.type === "error") throw new Error(r.error.message);
    if (!r.response || !r.response.result) return [];
    const { cols, rows } = r.response.result;
    return rows.map((row) => {
      const obj = {};
      cols.forEach((c, idx) => (obj[c.name] = row[idx]?.value ?? null));
      return obj;
    });
  });
}

let isInitialized = false;
async function ensureDatabase(env) {
  if (isInitialized) return;
  await tursoQuery(env, [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      access_type TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT DEFAULT 'Tim SMAN 2 Karanganyar',
      pdf_url TEXT NOT NULL,
      thumbnail_url TEXT,
      category_id TEXT NOT NULL,
      access_type TEXT NOT NULL,
      uploaded_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT OR IGNORE INTO categories (id, name, access_type) VALUES 
      ('cat-mat', 'Matematika', 'umum'),
      ('cat-fis', 'Fisika', 'umum'),
      ('cat-kim', 'Kimia', 'umum'),
      ('cat-bio', 'Biologi', 'umum'),
      ('cat-ind', 'Bahasa Indonesia', 'umum'),
      ('cat-ing', 'Bahasa Inggris', 'umum'),
      ('cat-nov', 'Novel & Sastra', 'umum'),
      ('cat-tka', 'TKA', 'referensi'),
      ('cat-smbt', 'SMBT / SNBT', 'referensi'),
      ('cat-soal', 'Data Soal', 'referensi')`,
    `INSERT OR IGNORE INTO users (id, nama, username, password, role, is_active) VALUES 
      ('usr-admin', 'Super Admin SMANDA', 'admin', 'smanda2026', 'super_admin', 1),
      ('usr-guru', 'Guru Kontributor', 'guru', 'guru2026', 'kontributor', 1),
      ('usr-siswa', 'Siswa SMAN 2 Karanganyar', 'siswa', 'belajar123', 'siswa', 1)`
  ]);
  isInitialized = true;
}

async function extractPdfMetadata(pdfUrl) {
  let title = "";
  let thumbnailUrl = "";
  const gdriveMatch = pdfUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || pdfUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);

  if (gdriveMatch && gdriveMatch[1]) {
    const fileId = gdriveMatch[1];
    thumbnailUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w600`;
    try {
      const pageRes = await fetch(`https://drive.google.com/file/d/${fileId}/view`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const html = await pageRes.text();
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch && titleMatch[1]) {
        title = titleMatch[1].replace(/ - Google Drive$/i, "").replace(/\.pdf$/i, "").trim();
      }
    } catch (_) {}
  } else {
    try {
      const urlObj = new URL(pdfUrl);
      const rawName = decodeURIComponent(urlObj.pathname.split("/").pop() || "");
      title = rawName.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();
    } catch (_) {}
  }

  return { title: title || "Dokumen Perpustakaan SMANDA", thumbnailUrl };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname;

  try {
    await ensureDatabase(env);

    if (path === "/api/init" && request.method === "GET") {
      const [categories, books] = await tursoQuery(env, [
        "SELECT * FROM categories ORDER BY access_type ASC, name ASC",
        "SELECT b.*, c.name as category_name FROM books b LEFT JOIN categories c ON b.category_id = c.id ORDER BY b.created_at DESC"
      ]);
      return jsonResponse({ ok: true, categories, books });
    }

    if (path === "/api/login" && request.method === "POST") {
      const { username, password } = await request.json();
      const [rows] = await tursoQuery(env, [{
        sql: "SELECT id, nama, username, role, is_active FROM users WHERE username = ? AND password = ? LIMIT 1",
        args: [
          { type: "text", value: String(username || "").trim() },
          { type: "text", value: String(password || "").trim() }
        ]
      }]);
      if (!rows.length) return jsonResponse({ ok: false, error: "Username atau password salah." }, 401);
      if (String(rows[0].is_active) === "0") return jsonResponse({ ok: false, error: "Akun dinonaktifkan oleh Admin." }, 403);
      return jsonResponse({ ok: true, user: rows[0] });
    }

    if (path === "/api/extract" && request.method === "POST") {
      const { pdf_url } = await request.json();
      if (!pdf_url) return jsonResponse({ ok: false, error: "URL wajib diisi" }, 400);
      return jsonResponse({ ok: true, ...(await extractPdfMetadata(pdf_url.trim())) });
    }

    if (path === "/api/books" && request.method === "POST") {
      const body = await request.json();
      const id = "bk-" + Date.now();
      await tursoQuery(env, [{
        sql: "INSERT INTO books (id, title, author, pdf_url, thumbnail_url, category_id, access_type, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          { type: "text", value: id },
          { type: "text", value: body.title },
          { type: "text", value: body.author || "SMAN 2 Karanganyar" },
          { type: "text", value: body.pdf_url },
          { type: "text", value: body.thumbnail_url || "" },
          { type: "text", value: body.category_id },
          { type: "text", value: body.access_type },
          { type: "text", value: body.uploaded_by || "admin" }
        ]
      }]);
      return jsonResponse({ ok: true, id });
    }

    if (path === "/api/books/delete" && request.method === "POST") {
      const { id } = await request.json();
      await tursoQuery(env, [{ sql: "DELETE FROM books WHERE id = ?", args: [{ type: "text", value: id }] }]);
      return jsonResponse({ ok: true });
    }

    if (path === "/api/categories" && request.method === "POST") {
      const { name, access_type } = await request.json();
      const id = "cat-" + Date.now();
      await tursoQuery(env, [{
        sql: "INSERT INTO categories (id, name, access_type) VALUES (?, ?, ?)",
        args: [
          { type: "text", value: id },
          { type: "text", value: name.trim() },
          { type: "text", value: access_type }
        ]
      }]);
      return jsonResponse({ ok: true, id });
    }

    if (path === "/api/users" && request.method === "GET") {
      const [users] = await tursoQuery(env, ["SELECT id, nama, username, role, is_active, created_at FROM users ORDER BY created_at DESC"]);
      return jsonResponse({ ok: true, users });
    }

    if (path === "/api/users" && request.method === "POST") {
      const { nama, username, password, role } = await request.json();
      const id = "usr-" + Date.now();
      await tursoQuery(env, [{
        sql: "INSERT INTO users (id, nama, username, password, role, is_active) VALUES (?, ?, ?, ?, ?, 1)",
        args: [
          { type: "text", value: id },
          { type: "text", value: nama.trim() },
          { type: "text", value: username.trim() },
          { type: "text", value: password.trim() },
          { type: "text", value: role }
        ]
      }]);
      return jsonResponse({ ok: true, id });
    }

    if (path === "/api/users/toggle" && request.method === "POST") {
      const { id, is_active } = await request.json();
      await tursoQuery(env, [{
        sql: "UPDATE users SET is_active = ? WHERE id = ?",
        args: [
          { type: "integer", value: String(is_active ? 1 : 0) },
          { type: "text", value: id }
        ]
      }]);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: "Endpoint tidak ditemukan" }, 404);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}
