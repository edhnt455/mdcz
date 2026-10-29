import { isOpenDeletionJob } from "@mdcz/shared/deletions";
import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../lib/queryKeys";

export const useDeletionJobs = () =>
  useQuery({
    queryKey: queryKeys.deletions.all,
    queryFn: () => api.deletions.list(),
    retry: false,
    staleTime: 1_000,
    refetchInterval: (query) => (query.state.data?.jobs.some(isOpenDeletionJob) ? 1_500 : 10_000),
  });
