/** Parser CSV RFC 4180: aspas, aspas escapadas, quebras de linha dentro de campo. Detecta `,` ou `;`. */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const HEADER_ALIASES: Record<string, string> = {
  nome: "name",
  name: "name",
  "nome completo": "name",
  email: "email",
  "e-mail": "email",
  telefone: "phone",
  celular: "phone",
  whatsapp: "phone",
  phone: "phone",
  origem: "source",
  fonte: "source",
  source: "source",
  etapa: "stage",
  "estágio": "stage",
  estagio: "stage",
  stage: "stage",
  valor: "amount",
  amount: "amount",
  utm: "utm",
  consentimento: "consent",
  consent: "consent",
  "opt-in": "consent",
  optin: "consent",
  id: "externalId",
  "id externo": "externalId",
  external_id: "externalId",
};

export type CsvLeadRow = {
  line: number;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
  stage?: string;
  amount?: string;
  utm?: string;
  consent?: string;
  externalId?: string;
};

export function csvToLeadRows(text: string): CsvLeadRow[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
  return rows.map((cells, idx) => {
    const out: CsvLeadRow = { line: idx + 2 };
    keys.forEach((key, col) => {
      if (key) (out as Record<string, unknown>)[key] = cells[col]?.trim() ?? "";
    });
    return out;
  });
}

export function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "sim", "s", "yes", "y", "x", "ok"].includes((value ?? "").trim().toLowerCase());
}
