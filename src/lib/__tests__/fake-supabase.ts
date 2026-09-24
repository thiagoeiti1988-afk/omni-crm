// Fake mínimo de query builder Supabase para testar db.ts/mcp.ts sem rede.
// Cobre só o subconjunto de encadeamento usado em src/lib/db.ts.

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

function matchFilters(row: Row, filters: Record<string, unknown>): boolean {
  return Object.entries(filters).every(([key, value]) => row[key] === value);
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: 'select' | 'insert' | 'update' | null = null;
  private payload: Row | null = null;
  private filters: Record<string, unknown> = {};

  constructor(private store: Store, private table: string) {}

  select(): this {
    if (!this.op) this.op = 'select';
    return this;
  }

  insert(payload: Row): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Row): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters[column] = value;
    return this;
  }

  order(): this {
    return this;
  }

  maybeSingle() {
    return this.resolve(true);
  }

  private resolve(single: boolean): Promise<{ data: unknown; error: unknown }> {
    return Promise.resolve().then(() => {
      if (!this.store[this.table]) this.store[this.table] = [];
      const rows = this.store[this.table];

      if (this.op === 'insert') {
        const row = { id: `id-${rows.length + 1}`, created_at: new Date().toISOString(), ...this.payload };
        rows.push(row);
        return { data: row, error: null };
      }

      if (this.op === 'update') {
        const idx = rows.findIndex((r) => matchFilters(r, this.filters));
        if (idx === -1) return { data: null, error: null };
        rows[idx] = { ...rows[idx], ...this.payload };
        return { data: rows[idx], error: null };
      }

      const matched = rows.filter((r) => matchFilters(r, this.filters));
      return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
    });
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.resolve(false).then(onfulfilled, onrejected);
  }
}

export function createFakeClient(seed: Store = {}) {
  const store: Store = JSON.parse(JSON.stringify(seed));
  return {
    from(table: string) {
      return new FakeQueryBuilder(store, table);
    },
    __store: store,
  } as unknown as import('@supabase/supabase-js').SupabaseClient & { __store: Store };
}
