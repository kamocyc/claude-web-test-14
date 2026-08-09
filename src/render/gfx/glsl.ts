/** シェーダ間で共有する GLSL 断片。 */

/** グリッドテクスチャの自前バイリニア補間 (浮動小数テクスチャは線形補間できないため) */
export const FIELD_GLSL = /* glsl */ `
uniform vec2 uMapSize;

vec4 fieldTexel(sampler2D tex, vec2 c) {
  return texture2D(tex, (clamp(c, vec2(0.0), uMapSize - 1.0) + 0.5) / uMapSize);
}

/** cell はセル中心座標 (0..MAP-1) */
float sampleH(sampler2D tex, vec2 cell) {
  vec2 c = clamp(cell, vec2(0.0), uMapSize - 1.0);
  vec2 i = floor(c);
  vec2 f = c - i;
  float h00 = fieldTexel(tex, i).r;
  float h10 = fieldTexel(tex, i + vec2(1.0, 0.0)).r;
  float h01 = fieldTexel(tex, i + vec2(0.0, 1.0)).r;
  float h11 = fieldTexel(tex, i + vec2(1.0, 1.0)).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

vec4 sampleV(sampler2D tex, vec2 cell) {
  vec2 c = clamp(cell, vec2(0.0), uMapSize - 1.0);
  vec2 i = floor(c);
  vec2 f = c - i;
  vec4 v00 = fieldTexel(tex, i);
  vec4 v10 = fieldTexel(tex, i + vec2(1.0, 0.0));
  vec4 v01 = fieldTexel(tex, i + vec2(0.0, 1.0));
  vec4 v11 = fieldTexel(tex, i + vec2(1.0, 1.0));
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}
`;

/**
 * 空の色。天球メッシュと水面の反射で同じ関数を使うので、
 * 水に映る空と実際の空がずれない。
 */
export const SKY_GLSL = /* glsl */ `
vec3 skyRadiance(vec3 dir, vec3 sunDir, vec3 zenithCol, vec3 horizonCol, vec3 groundCol, vec3 sunCol) {
  float up = dir.y;
  float t = pow(clamp(up, 0.0, 1.0), 0.42);
  vec3 col = mix(horizonCol, zenithCol, t);
  // 地平線下は地面の反射色へ落とす
  col = mix(mix(groundCol, horizonCol, clamp(up * 6.0 + 1.0, 0.0, 1.0)), col, step(0.0, up));
  float cosA = clamp(dot(normalize(dir), sunDir), 0.0, 1.0);
  // 太陽まわりの散乱 (ハロ) と太陽そのもの
  col += sunCol * pow(cosA, 6.0) * 0.11;
  col += sunCol * pow(cosA, 900.0) * 12.0;
  return col;
}
`;
