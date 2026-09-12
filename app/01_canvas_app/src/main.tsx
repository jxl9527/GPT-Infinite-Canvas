import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ProjectWorkbench } from "./ProjectWorkbench";
import type { WorkbenchProject } from "./bridge-client";
import { projectIdFromUrl, urlForProject, urlForWorkbench } from "./project-route";
import "./styles.css";
import "./product-upgrades.css";
import { SimpleWorkspace } from "./SimpleWorkspace";

const root = document.getElementById("root");
if (!root) throw new Error("未找到应用挂载节点");

function WorkspaceRoot() {
  const [project, setProject] = useState<WorkbenchProject | null>(null);
  const [requestedProjectId, setRequestedProjectId] = useState(() => projectIdFromUrl(window.location.href));
  const openProject = useCallback((nextProject: WorkbenchProject) => {
    setProject(nextProject);
    setRequestedProjectId(nextProject.id);
    window.history.replaceState(null, "", urlForProject(window.location.href, nextProject.id));
  }, []);
  const returnToProjects = useCallback(() => {
    setRequestedProjectId(null);
    setProject(null);
    window.history.replaceState(null, "", urlForWorkbench(window.location.href));
  }, []);
  return project
    ? <App
        key={project.id}
        projectId={project.id}
        projectName={project.name}
        onBackToProjects={returnToProjects}
      />
    : <ProjectWorkbench onOpen={openProject} requestedProjectId={requestedProjectId} />;
}

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(location.search).get("legacy") === "1" ? <WorkspaceRoot /> : <SimpleWorkspace />}
  </StrictMode>
);
