import * as THREE from 'three';
import { CELL, MAP, VOXEL, voxelBlocksPerCell } from '../../config';
import type { FieldTextures } from './fields';
import { createTextures, type GfxTextures } from './textures';

/**
 * 地形・水面・空で共有するユニフォーム。
 * 同じオブジェクトを各マテリアルへ渡しているので、ここを書き換えれば全部に反映される。
 */
export interface SharedUniforms {
  uMapSize: { value: THREE.Vector2 };
  uCell: { value: number };
  /** 高さ方向の強調率 (1 = 実寸) */
  uVScale: { value: number };
  /** ボクセル1個の高さ (m)。0 = ボクセル表示オフ */
  uVoxel: { value: number };
  /** ブロックの目地の間隔 (m)。立方体に見えるよう uVScale に連動する */
  uBlockXZ: { value: number };
  /** ジオラマの底 (m)。マップ外の境界面をここまで落として側面を作る */
  uVoxelFloor: { value: number };
  uTime: { value: number };

  uHeightTex: { value: THREE.Texture };
  uWaterTex: { value: THREE.Texture };
  uSurfTex: { value: THREE.Texture };
  uOverlayTex: { value: THREE.Texture };
  uOverlayAmt: { value: number };

  uDetailTex: { value: THREE.Texture };
  uDetailNormal: { value: THREE.Texture };
  uWaveNormal: { value: THREE.Texture };
  uFoamTex: { value: THREE.Texture };

  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uGroundCol: { value: THREE.Color };

  uGrid: { value: number };
  uContour: { value: number };
  uSnowLine: { value: number };
  /** 0 = 乾季の色, 1 = 雨季の色 (草の青さ) */
  uSeasonGreen: { value: number };
  /** 地表の積雪量 0..1 */
  uSnowFall: { value: number };
  uWetness: { value: number };
}

export function createSharedUniforms(fields: FieldTextures, maxHeight: number): SharedUniforms {
  const tex: GfxTextures = createTextures();
  return {
    uMapSize: { value: new THREE.Vector2(MAP, MAP) },
    uCell: { value: CELL },
    uVScale: { value: 1.45 },
    uVoxel: { value: VOXEL.enabled ? VOXEL.SIZE : 0 },
    uBlockXZ: { value: CELL / voxelBlocksPerCell(1.45) },
    uVoxelFloor: { value: -24 },
    uTime: { value: 0 },

    uHeightTex: { value: fields.height },
    uWaterTex: { value: fields.water },
    uSurfTex: { value: fields.surface },
    uOverlayTex: { value: fields.overlay },
    uOverlayAmt: { value: 0 },

    uDetailTex: { value: tex.detail },
    uDetailNormal: { value: tex.detailNormal },
    uWaveNormal: { value: tex.waveNormal },
    uFoamTex: { value: tex.foam },

    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.35).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.96, 0.88) },
    uZenith: { value: new THREE.Color(0.18, 0.36, 0.72) },
    uHorizon: { value: new THREE.Color(0.72, 0.82, 0.92) },
    uGroundCol: { value: new THREE.Color(0.14, 0.15, 0.14) },

    uGrid: { value: 0 },
    uContour: { value: 0 },
    uSnowLine: { value: Math.max(70, maxHeight * 0.74) },
    uSeasonGreen: { value: 1 },
    uSnowFall: { value: 0 },
    uWetness: { value: 0 },
  };
}
