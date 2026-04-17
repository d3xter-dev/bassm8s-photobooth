import SonyCamera from '~~/server/camera/strategies/SonyCamera';
import type { CameraStrategy, CameraType } from '~~/server/camera/types';
import CanonCamera from './strategies/CanonCamera';

export function createCamera(type: CameraType): CameraStrategy {
  switch (type) {
    case 'sony_wifi':
      return new SonyCamera();
    case 'canon':
      return new CanonCamera();
    default:
      throw new Error(`Unsupported camera type: ${String(type)}`);
  }
}
