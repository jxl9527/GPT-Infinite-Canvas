export interface ImportFileLike {
  name: string;
  webkitRelativePath?: string;
}

export function importFileDisplayName(file: ImportFileLike): string {
  return file.webkitRelativePath || file.name;
}

export function naturalSortImportFiles<T extends ImportFileLike>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => importFileDisplayName(left).localeCompare(
    importFileDisplayName(right),
    "zh-CN",
    { numeric: true, sensitivity: "base" }
  ));
}

export function containsFolderFiles(files: readonly ImportFileLike[]): boolean {
  return files.some((file) => Boolean(file.webkitRelativePath?.trim()));
}
