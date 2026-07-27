export function shouldAutoReturnResults(
  status: string | undefined,
  resultCount: number,
  returnedCount: number,
  returning: boolean
): boolean {
  return status === "completed"
    && resultCount > 0
    && returnedCount < resultCount
    && !returning;
}
