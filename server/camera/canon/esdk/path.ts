import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { arch, platform } from 'node:process';

export type EsdkPlatformKind = 'linux' | 'windows' | 'darwin' | 'unsupported';

/**
 * Resolve the EDSDK shared library under server/vendor/esdk.
 * macOS: prefers vendored `macos/EDSDK.framework/Versions/A/EDSDK` (or `Current`).
 * Override with `camera.edsdkMacosDylibPath` for a custom path.
 */
export function resolveEsdkLibPath(overrides?: {
  vendorRoot?: string;
  macosDylibPath?: string;
  windowsDllPath?: string;
  linuxSoPath?: string;
}): { kind: EsdkPlatformKind; primary: string; extraPaths: string[]; error?: string } {
  const vendorRoot = overrides?.vendorRoot ?? join(import.meta.dirname, '../../../vendor/esdk');

  if (overrides?.linuxSoPath && existsSync(overrides.linuxSoPath)) {
    return { kind: 'linux', primary: overrides.linuxSoPath, extraPaths: [dirname(overrides.linuxSoPath)] };
  }
  if (overrides?.windowsDllPath && existsSync(overrides.windowsDllPath)) {
    const dir = dirname(overrides.windowsDllPath);
    return { kind: 'windows', primary: overrides.windowsDllPath, extraPaths: [dir] };
  }
  if (overrides?.macosDylibPath && existsSync(overrides.macosDylibPath)) {
    return { kind: 'darwin', primary: overrides.macosDylibPath, extraPaths: [dirname(overrides.macosDylibPath)] };
  }

  const plat = platform;
  if (plat === 'linux') {
    let sub = 'x86_64';
    if (arch === 'arm64') sub = 'ARM64';
    else if (arch === 'arm') sub = 'ARM32';
    const so = join(vendorRoot, 'linux', sub, 'libEDSDK.so');
    if (!existsSync(so)) {
      return {
        kind: 'linux',
        primary: so,
        extraPaths: [],
        error: `Missing ${so} (arch=${arch})`
      };
    }
    return { kind: 'linux', primary: so, extraPaths: [join(vendorRoot, 'linux', sub)] };
  }

  if (plat === 'win32') {
    const dll = join(vendorRoot, 'windows', 'EDSDK.dll');
    if (!existsSync(dll)) {
      return { kind: 'windows', primary: dll, extraPaths: [], error: `Missing ${dll}` };
    }
    return { kind: 'windows', primary: dll, extraPaths: [join(vendorRoot, 'windows')] };
  }

  if (plat === 'darwin') {
    const fwA = join(vendorRoot, 'macos', 'EDSDK.framework', 'Versions', 'A', 'EDSDK');
    const fwCurrent = join(vendorRoot, 'macos', 'EDSDK.framework', 'Versions', 'Current', 'EDSDK');
    let primary = '';
    if (existsSync(fwA)) primary = fwA;
    else if (existsSync(fwCurrent)) primary = fwCurrent;

    if (primary) {
      const versionDir = dirname(primary);
      return {
        kind: 'darwin',
        primary,
        extraPaths: [versionDir, join(vendorRoot, 'macos', 'EDSDK.framework')]
      };
    }

    const dmgZip = join(vendorRoot, 'macos', 'Macintosh.dmg.zip');
    if (existsSync(dmgZip)) {
      return {
        kind: 'darwin',
        primary: dmgZip,
        extraPaths: [],
        error:
          'macOS: Macintosh.dmg.zip is not loadable; add EDSDK.framework under server/vendor/esdk/macos/ or set camera.edsdkMacosDylibPath'
      };
    }
    return {
      kind: 'darwin',
      primary: '',
      extraPaths: [],
      error:
        'macOS: no EDSDK.framework found — add server/vendor/esdk/macos/EDSDK.framework or set camera.edsdkMacosDylibPath'
    };
  }

  return { kind: 'unsupported', primary: '', extraPaths: [], error: `Unsupported platform ${plat}` };
}
