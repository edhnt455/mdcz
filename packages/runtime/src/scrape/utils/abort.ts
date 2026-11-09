export const ABORT_ERROR_NAME = "AbortError";
export const ABORT_ERROR_MESSAGE = "操作已中止";

export const createAbortError = (): Error => {
  const error = new Error(ABORT_ERROR_MESSAGE);
  error.name = ABORT_ERROR_NAME;
  return error;
};

export const isAbortError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === ABORT_ERROR_NAME || error.message === ABORT_ERROR_MESSAGE;
};

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createAbortError();
  }
};
