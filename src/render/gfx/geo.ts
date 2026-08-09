import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * ジオメトリの結合。
 * three の mergeGeometries は「全部インデックス付き」か「全部なし」でないと失敗するが、
 * BoxGeometry はインデックス付き、IcosahedronGeometry や ExtrudeGeometry はインデックスなし
 * なので、混ざったらインデックスなしに揃えてから結合する。
 */
export function mergeParts(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const indexed = list.filter((g) => g.index !== null).length;
  let parts = list;
  if (indexed !== 0 && indexed !== list.length) {
    parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  }
  const merged = mergeGeometries(parts, false);
  for (const g of list) g.dispose();
  for (const g of parts) if (!list.includes(g)) g.dispose();
  if (!merged) throw new Error('ジオメトリを結合できません');
  return merged;
}
