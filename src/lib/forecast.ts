export type SeriesPoint = { x: number; y: number };

export type LinearModel = { intercept: number; slope: number };

export type QuadraticModel = { a: number; b: number; c: number };

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
}

/** Ordinary least squares: y = intercept + slope * x */
export function fitLinear(points: SeriesPoint[]): LinearModel {
  if (points.length < 2) return { intercept: points[0]?.y ?? 0, slope: 0 };
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

export function predictLinear(model: LinearModel, x: number): number {
  return model.intercept + model.slope * x;
}

/**
 * Least squares parabola y = a + b x + c x²
 * Used as a simple curvature / acceleration model (not a market oracle).
 */
export function fitQuadratic(points: SeriesPoint[]): QuadraticModel {
  if (points.length < 3) {
    const lin = fitLinear(points);
    return { a: lin.intercept, b: lin.slope, c: 0 };
  }
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0,
    t0 = 0,
    t1 = 0,
    t2 = 0;
  for (const p of points) {
    const x = p.x;
    const y = p.y;
    const x2 = x * x;
    s0 += 1;
    s1 += x;
    s2 += x2;
    s3 += x2 * x;
    s4 += x2 * x2;
    t0 += y;
    t1 += x * y;
    t2 += x2 * y;
  }
  const M = [
    [s0, s1, s2, t0],
    [s1, s2, s3, t1],
    [s2, s3, s4, t2],
  ];
  const solved = solve3(M);
  if (!solved) {
    const lin = fitLinear(points);
    return { a: lin.intercept, b: lin.slope, c: 0 };
  }
  return { a: solved[0], b: solved[1], c: solved[2] };
}

function solve3(aug: number[][]): number[] | null {
  const a = aug.map((row) => row.slice());
  const n = 3;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
    }
    if (Math.abs(a[piv][i]) < 1e-12) return null;
    if (piv !== i) {
      const tmp = a[i];
      a[i] = a[piv];
      a[piv] = tmp;
    }
    const div = a[i][i];
    for (let c = i; c <= n; c++) a[i][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i];
      for (let c = i; c <= n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

export function predictQuadratic(model: QuadraticModel, x: number): number {
  return model.a + model.b * x + model.c * x * x;
}

export function rSquared(points: SeriesPoint[], predict: (x: number) => number): number {
  if (points.length < 2) return 0;
  const my = mean(points.map((p) => p.y));
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const err = p.y - predict(p.x);
    ssRes += err * err;
    const d = p.y - my;
    ssTot += d * d;
  }
  if (ssTot === 0) return 1;
  return 1 - ssRes / ssTot;
}
