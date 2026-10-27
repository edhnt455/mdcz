export type ConnectionCheckStatus = "ok" | "error" | "skipped";
export type ConnectionServerInfo = {
  serverName?: string;
  version?: string;
};

export type MediaServerCheckKey = "server" | "auth" | "peopleRead" | "peopleWrite" | "adminKey";

/** Why a step ended as it did, so the UI can explain it without backend prose. */
export type ConnectionCheckReason =
  | "service_unreachable"
  | "auth_rejected"
  | "auth_unverified"
  | "people_check_failed"
  | "empty_library";

export type MediaServerCheckStep = {
  key: MediaServerCheckKey;
  status: ConnectionCheckStatus;
  reason?: ConnectionCheckReason;
  /** Raw error text from the server or network layer. */
  detail?: string;
  code?: string;
};

export type MediaServerConnectionCheckResult = {
  success: boolean;
  steps: MediaServerCheckStep[];
  serverInfo?: ConnectionServerInfo;
  personCount?: number;
};

export type PersonSyncFailure = { personId: string; name: string; stage: string; message: string };

export type PersonSyncResult = {
  processedCount: number;
  failedCount: number;
  skippedCount: number;
  failures?: PersonSyncFailure[];
};

export type AmazonPosterScanItem = {
  nfoPath: string;
  directory: string;
  title: string;
  searchTitle: string;
  number: string;
  currentPosterPath: string | null;
  currentPosterWidth: number;
  currentPosterHeight: number;
  currentPosterSize: number;
};

export type AmazonPosterLookupReason =
  | "found"
  | "missing_title"
  | "search_failed"
  | "no_results"
  | "no_match"
  | "detail_unreadable"
  | "image_unreachable"
  | "query_failed";

export type AmazonPosterLookupResult = {
  nfoPath: string;
  amazonPosterUrl: string | null;
  reason: AmazonPosterLookupReason;
  /** Raw error text when reason is "query_failed". */
  error?: string;
  elapsedMs: number;
};

export type AmazonPosterApplyResultItem = {
  directory: string;
  success: boolean;
  savedPosterPath: string;
  replacedExisting: boolean;
  fileSize: number;
  error?: string;
};

export type BatchTranslateField = import("./config").TranslationField;

/**
 * `all` translates the source text again even where a translation exists, e.g. after switching models; `restore`
 * drops translations so the NFO shows the source text it keeps alongside.
 */
export type BatchTranslateMode = "untranslated" | "all" | "restore";
export type BatchTranslateApplyMode = BatchTranslateMode | "ignore";

export type BatchTranslateScanItem = {
  filePath: string;
  nfoPath: string;
  directory: string;
  number: string;
  title: string;
  plot: string;
  pendingFields: BatchTranslateField[];
  reason: "task_failed" | "content";
};

export type BatchTranslateApplyResultItem = {
  filePath: string;
  nfoPath: string;
  directory: string;
  number: string;
  success: boolean;
  translatedFields: BatchTranslateField[];
  savedNfoPath?: string;
  title?: string;
  plot?: string;
  error?: string;
};

export type BatchTranslateApplyInput = {
  mode: BatchTranslateApplyMode;
  items?: BatchTranslateScanItem[];
  batchSize?: number;
};
