import { describe, expect, it } from 'vitest';
import { Camera } from '../src/render/camera';
import { Simulation } from '../src/sim/simulation';

/** 横移動を n フレームぶん回して、カメラの上下動を測る */
function traverse(cam: Camera, n = 300): { maxStep: number; avgStep: number; range: number } {
  const step = (cam.distance * 1.15) / 60; // キー移動 1 フレームぶん
  let prev = cam.camera.position.y;
  let maxStep = 0;
  let sum = 0;
  let lo = prev;
  let hi = prev;
  for (let i = 0; i < n; i++) {
    cam.moveBy(step, 0);
    cam.tick(1 / 60);
    const y = cam.camera.position.y;
    maxStep = Math.max(maxStep, Math.abs(y - prev));
    sum += Math.abs(y - prev);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
    prev = y;
  }
  return { maxStep, avgStep: sum / n, range: hi - lo };
}

describe('カメラ', () => {
  it('横移動しても地形の細かい凹凸で上下に揺れない', () => {
    const sim = new Simulation(4242, 0.12);
    const cam = new Camera(sim.world);
    cam.distance = 620;
    cam.pitch = 0.62;
    cam.centerOn(sim.world.w * 0.2, sim.world.h * 0.5);

    const r = traverse(cam);
    // 注視点をその地点の標高に直結させていた頃は、谷を1つ越えるだけで
    // 1フレームに 16m 跳ねる場所があった (平均 0.81m)。
    expect(r.maxStep).toBeLessThan(4);
    expect(r.avgStep).toBeLessThan(0.45);
    // ただし固定してしまうのではなく、大きな起伏には乗っていること
    expect(r.range).toBeGreaterThan(40);
  }, 60000);

  it('引くほど広く均すので、遠景ほど揺れが小さい', () => {
    const sim = new Simulation(4242, 0.12);
    const near = new Camera(sim.world);
    near.distance = 300;
    near.pitch = 0.62;
    near.centerOn(sim.world.w * 0.2, sim.world.h * 0.5);
    const far = new Camera(sim.world);
    far.distance = 1200;
    far.pitch = 0.62;
    far.centerOn(sim.world.w * 0.2, sim.world.h * 0.5);

    // 移動距離は距離に比例するので、1m あたりの上下動で比べる
    const n = traverse(near).avgStep / ((near.distance * 1.15) / 60);
    const f = traverse(far).avgStep / ((far.distance * 1.15) / 60);
    expect(f).toBeLessThan(n);
  }, 60000);
});
