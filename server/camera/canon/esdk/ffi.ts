/// <reference types="bun" />
/**
 * Bun-only: EDSDK C API via dlopen. Do not import from Node/Nitro.
 */
import { dlopen, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';

export type EdsBindings = ReturnType<typeof loadEdsBindings>;

export function loadEdsBindings(libPath: string) {
  const lib = dlopen(libPath, {
    EdsInitializeSDK: {
      args: [],
      returns: FFIType.u32
    },
    EdsTerminateSDK: {
      args: [],
      returns: FFIType.u32
    },
    EdsRetain: {
      args: [FFIType.ptr],
      returns: FFIType.u32
    },
    EdsRelease: {
      args: [FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetCameraList: {
      args: [FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetChildCount: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetChildAtIndex: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsOpenSession: {
      args: [FFIType.ptr],
      returns: FFIType.u32
    },
    EdsCloseSession: {
      args: [FFIType.ptr],
      returns: FFIType.u32
    },
    EdsSetPropertyData: {
      args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetPropertyData: {
      args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsSendCommand: {
      args: [FFIType.ptr, FFIType.u32, FFIType.i32],
      returns: FFIType.u32
    },
    /** `EdsCapacity*` — see `tagEdsCapacity` in EDSDKTypes.h */
    EdsSetCapacity: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsCreateMemoryStream: {
      args: [FFIType.u32, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsCreateEvfImageRef: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsDownloadEvfImage: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetPointer: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetLength: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsSetObjectEventHandler: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsSetPropertyEventHandler: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsSetCameraStateEventHandler: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetDirectoryItemInfo: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsDownload: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.u32
    },
    EdsDownloadComplete: {
      args: [FFIType.ptr],
      returns: FFIType.u32
    },
    EdsDownloadCancel: {
      args: [FFIType.ptr],
      returns: FFIType.u32
    },
    EdsGetEvent: {
      args: [],
      returns: FFIType.u32
    }
  });

  return lib;
}

export function readU32(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
}

/** Little-endian u64 — matches `EdsUInt64` in EDSDKTypes.h (e.g. EdsDirectoryItemInfo.size). */
export function readU64LE(buf: Uint8Array, byteOffset = 0): bigint {
  return new DataView(buf.buffer, buf.byteOffset + byteOffset, 8).getBigUint64(0, true);
}

export function writeU32(buf: Uint8Array, v: number) {
  new DataView(buf.buffer, buf.byteOffset, 4).setUint32(0, v >>> 0, true);
}

export function readU64Ptr(buf: Uint8Array): number {
  return Number(new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true));
}

export function bufferFromNativePtr(nativePtr: number, length: number): Buffer {
  if (nativePtr === 0 || length === 0) return Buffer.alloc(0);
  const ab = toArrayBuffer(nativePtr as never, 0, length);
  return Buffer.from(ab);
}

export { ptr, read, toArrayBuffer };
