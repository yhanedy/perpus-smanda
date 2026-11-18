async function tursoQuery(env, statements) {
  const rawUrl = (env.TURSO_DATABASE_URL || "").replace(/^libsql:\/\//, "https://").trim();
  const token = (env.TURSO_AUTH_TOKEN || "").trim();

  if (!rawUrl || !token) {
    throw new Error("TURSO_DATABASE_URL atau TURSO_AUTH_TOKEN belum diatur di Settings Cloudflare.");
  }

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

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Turso Error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.results.map((r) => {
    if (r.type === "error") throw new Error(r.error.message);
    if (!r.response || !r.response.result) return [];
    const { cols, rows } = r.response.result;
    return rows.map((row) => {
      const obj = {};
      cols.forEach((c, idx) => {
        obj[c.name] = row[idx]?.value ?? null;
      });
      return obj;
    });
  });
}
