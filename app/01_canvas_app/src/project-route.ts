const PROJECT_ID_PATTERN = /^project_[A-Za-z0-9-]+$/;

export function projectIdFromUrl(href: string): string | null {
  try {
    const projectId = new URL(href).searchParams.get("project")?.trim() ?? "";
    return PROJECT_ID_PATTERN.test(projectId) ? projectId : null;
  } catch {
    return null;
  }
}

export function urlForProject(href: string, projectId: string): string {
  const url = new URL(href);
  if (PROJECT_ID_PATTERN.test(projectId)) url.searchParams.set("project", projectId);
  else url.searchParams.delete("project");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function urlForWorkbench(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("project");
  return `${url.pathname}${url.search}${url.hash}`;
}
