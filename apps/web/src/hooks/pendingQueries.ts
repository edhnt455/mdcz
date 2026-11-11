import { queryOptions } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../lib/queryKeys";

export const pendingListQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.pending.all,
    queryFn: () => api.pending.list(),
    staleTime: 30_000,
    retry: false,
  });
