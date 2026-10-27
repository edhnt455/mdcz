import { useQuery } from "@tanstack/react-query";
import { fetchOutputSummary, overviewKeys } from "@/api/overview";

export const useOutputSummary = () =>
  useQuery({
    queryKey: overviewKeys.output,
    queryFn: fetchOutputSummary,
    staleTime: 60_000,
  });
