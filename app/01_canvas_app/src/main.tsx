import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ProjectWorkbench } from "./ProjectWorkbench";
import type { WorkbenchProject } from "./bridge-client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("未找到应用挂载节点");

function WorkspaceRoot() {
  const [project, setProject] = useState<WorkbenchProject | null>(null);
  return project
    ? <App key={project.id} projectId={project.id} projectName={project.name} />
    : <ProjectWorkbench onOpen={setProject} />;
}

createRoot(root).render(
  <StrictMode>
    <WorkspaceRoot />
  </StrictMode>
);
