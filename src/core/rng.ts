/** 決定論的な擬似乱数 (mulberry32)。同じシードなら常に同じ世界が生成される。 */
export class RNG {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** [0, n) の整数 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** 正規分布 (Box-Muller) */
  gauss(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

/** 文字列 → 32bit シード (FNV-1a) */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * ユーザが入力したシード (URL や入力欄) を 32bit の数値シードにする。
 * 数字ならそのまま、それ以外は文字列として潰す。空ならランダム。
 */
export function parseSeed(text: string | null | undefined): number {
  const t = (text ?? '').trim();
  if (!t) return randomSeed();
  return /^\d+$/.test(t) ? Number(t) >>> 0 : hashSeed(t);
}

/** 新しい流域用のランダムなシード */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** 座標と塩から決定論的な [0,1) を得る (予報など「未来を先読み」する用途) */
export function hash01(a: number, b: number, salt = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}
