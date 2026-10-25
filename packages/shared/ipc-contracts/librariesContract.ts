import { IpcChannel } from "../IpcChannel";
import type { IpcProcedure } from "../ipcTypes";
import type {
  MediaLibraryDto,
  MediaLibraryIdInput,
  MediaLibraryListResponse,
  MediaLibrarySettingsInput,
  MediaLibrarySourceInput,
  MediaLibraryStubProbeResponse,
  MediaLibraryUpdateInput,
} from "../mediaLibrary";
import type {
  PendingBatchInput,
  PendingBatchResponse,
  PendingConfirmUncensoredInput,
  PendingDetailResponse,
  PendingIdInput,
  PendingListResponse,
  PendingRetryInput,
  PendingRetryResponse,
} from "../pending";
import type { NamingPreviewItem } from "../types";

export type LibrariesIpcContract = {
  [IpcChannel.Pending_Batch]: IpcProcedure<PendingBatchInput, PendingBatchResponse>;
  [IpcChannel.Libraries_List]: IpcProcedure<void, MediaLibraryListResponse>;
  [IpcChannel.Libraries_Create]: IpcProcedure<MediaLibrarySettingsInput, MediaLibraryDto>;
  [IpcChannel.Libraries_Update]: IpcProcedure<MediaLibraryUpdateInput, MediaLibraryDto>;
  [IpcChannel.Libraries_Delete]: IpcProcedure<MediaLibraryIdInput, { success: true }>;
  [IpcChannel.Libraries_PreviewNaming]: IpcProcedure<MediaLibrarySettingsInput, { items: NamingPreviewItem[] }>;
  [IpcChannel.Libraries_ProbeStubs]: IpcProcedure<MediaLibrarySourceInput, MediaLibraryStubProbeResponse>;
  [IpcChannel.Pending_List]: IpcProcedure<void, PendingListResponse>;
  [IpcChannel.Pending_Detail]: IpcProcedure<PendingIdInput, PendingDetailResponse>;
  [IpcChannel.Pending_Retry]: IpcProcedure<PendingRetryInput, PendingRetryResponse>;
  [IpcChannel.Pending_ConfirmUncensored]: IpcProcedure<PendingConfirmUncensoredInput, { success: true }>;
  [IpcChannel.Pending_Ignore]: IpcProcedure<PendingIdInput, { success: true }>;
};
