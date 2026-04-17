/**
 * EDSDK numeric constants aligned with Canon headers:
 * - EDSDKTypes.h (Property IDs, commands, object events, enums)
 * - EDSDKErrors.h (EDS_ERR_*)
 *
 * Verify against your SDK copy: `Header/EDSDKTypes.h`, `Header/EDSDKErrors.h`.
 * PDF EDSDK_API should list the same property/command IDs as EDSDKTypes.h.
 */

/* --- EDSDKErrors.h --- */
export const EDS_ERR_OK = 0x0000_0000 as const;

/** Invalid argument / handle — common after USB disconnect while polling EVF */
export const EDS_ERR_INVALID_PARAMETER = 0x0000_0002 as const;

/** Camera busy — retry after `EdsGetEvent` */
export const EDS_ERR_DEVICE_BUSY = 0x0000_0081 as const;

/** PTP vendor: EVF / object not ready — expect when polling live view before frame is ready */
export const EDS_ERR_OBJECT_NOTREADY = 0x0000_a102 as const;

/** Often fixed by `EdsSetCapacity` when using `kEdsSaveTo_Host` */
export const EDS_ERR_TAKE_PICTURE_CARD_NG = 0x0000_8d07 as const;

/* --- kEdsPropID_* (EDSDKTypes.h) --- */
export const kEdsPropID_SaveTo = 0x0000_000b;
export const kEdsPropID_Evf_OutputDevice = 0x0000_0500;
export const kEdsPropID_Evf_Mode = 0x0000_0501;
/** DOF preview + PC output forces UI lock on many bodies (EDSDK §5.2.58) */
export const kEdsPropID_Evf_DepthOfFieldPreview = 0x0000_0504;

/** `EdsEvfMode` (EDSDKTypes.h) — live view must usually be `kEdsEvfMode_Evf` or EVF stops after a few frames. */
export const kEdsEvfMode_Off = 0;
export const kEdsEvfMode_Evf = 1;

export const kEdsEvfDepthOfFieldPreview_Off = 0;

/* --- EdsSaveTo (enum in EDSDKTypes.h) --- */
export const kEdsSaveTo_Camera = 1;
export const kEdsSaveTo_Host = 2;
export const kEdsSaveTo_Both = kEdsSaveTo_Camera | kEdsSaveTo_Host;

/* --- EdsEvfOutputDevice (enum in EDSDKTypes.h) --- */
export const kEdsEvfOutputDevice_TFT = 1;
/** Live view to PC */
export const kEdsEvfOutputDevice_PC = 2;
/** Some models */
export const kEdsEvfOutputDevice_PC_Small = 8;

/** Many bodies need TFT+PC for EVF to PC + host capture stability */
export const kEdsEvfOutputDevice_PC_and_TFT = kEdsEvfOutputDevice_TFT | kEdsEvfOutputDevice_PC;

/* --- EdsCameraCommand / EdsShutterButton (EDSDKTypes.h) --- */
export const kEdsCameraCommand_TakePicture = 0x0000_0000;
export const kEdsCameraCommand_PressShutterButton = 0x0000_0004;

export const kEdsCameraCommand_ShutterButton_OFF = 0x0000_0000;
export const kEdsCameraCommand_ShutterButton_Halfway = 0x0000_0001;
export const kEdsCameraCommand_ShutterButton_Completely = 0x0000_0003;
export const kEdsCameraCommand_ShutterButton_Halfway_NonAF = 0x0001_0001;
export const kEdsCameraCommand_ShutterButton_Completely_NonAF = 0x0001_0003;

/* --- EdsObjectEvent (EDSDKTypes.h) --- */
export const kEdsObjectEvent_All = 0x0000_0200;
export const kEdsObjectEvent_DirItemRequestTransfer = 0x0000_0208;

/* --- EdsPropertyEvent / EdsStateEvent (EDSDKTypes.h) --- */
export const kEdsPropertyEvent_All = 0x0000_0100;
export const kEdsStateEvent_All = 0x0000_0300;
export const kEdsStateEvent_Shutdown = 0x0000_0301;
