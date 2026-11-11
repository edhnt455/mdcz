import { queryOptions } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../lib/queryKeys";

export const pendingListQueryOptions = (newFiles = false) =>
  queryOptions({
    queryKey: newFiles ? queryKeys.pending.newFiles : queryKeys.pending.all,
    queryFn: () => (newFiles ? api.pending.newFiles() : api.pending.list()),
    staleTime: 30_000,
    retry: false,
  });
