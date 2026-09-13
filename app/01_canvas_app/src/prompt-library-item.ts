export interface PromptLibraryItem {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  category?: string;
  inputHint?: string;
  coverDataUrl?: string;
  coverLabel?: string;
  version?: number;
}
