// Provisiona uma organização real com owner, via a mesma rota de bootstrap do app.
// Uso: node scripts/create-org.mjs "Nome da Empresa" dona@empresa.com 'senha-com-10+'
// Em container: docker compose exec omni-crm node scripts/create-org.mjs ...
const [name, email, password] = process.argv.slice(2);
if (!name || !email || !password) {
  console.error('uso: node scripts/create-org.mjs "Empresa" owner@empresa.com "senha-forte"');
  process.exit(2);
}
const base = process.env.OMNI_URL ?? "http://127.0.0.1:3000";
const master = process.env.MCP_API_KEY;
if (!master) {
  console.error("defina MCP_API_KEY (chave master do operador)");
  process.exit(2);
}
const res = await fetch(`${base}/api/admin/orgs`, {
  method: "POST",
  headers: { Authorization: `Bearer ${master}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name, ownerEmail: email, ownerPassword: password }),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
