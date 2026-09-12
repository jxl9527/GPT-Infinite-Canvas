import { useCallback, useEffect, useState } from "react";
import { activateWorkbenchProject, assertSimpleBridgeReady, bindCanvasProject, createWorkbenchProject, listWorkbenchProjects, type WorkbenchProject } from "./bridge-client";
import { PromptGallery } from "./PromptGallery";
import { SimpleCanvas } from "./SimpleCanvas";
import { projectIdFromUrl, urlForProject, urlForWorkbench } from "./project-route";
import "./simple.css";

export function SimpleWorkspace() {
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeError, setBridgeError] = useState("");
  useEffect(() => { void assertSimpleBridgeReady().then(() => setBridgeReady(true)).catch((e: Error) => setBridgeError(e.message)); }, []);
  const [page, setPage] = useState<"library" | "canvas">(() => projectIdFromUrl(location.href) ? "canvas" : "library");
  const [project, setProject] = useState<WorkbenchProject | null>(null);
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const open = useCallback(async (id: string) => {
    setBusy(true); setError("");
    try { const next = await activateWorkbenchProject(id); setProject(next); setPage("canvas"); history.replaceState(null, "", urlForProject(location.href, next.id)); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);
  const load = async () => {
    try { const result = await listWorkbenchProjects(); setProjects(result.projects); return result; }
    catch (e) { setError((e as Error).message); return null; }
  };
  useEffect(() => {
    let cancelled = false;
    if (bridgeReady) void load().then((result) => { const id = projectIdFromUrl(location.href); if (!cancelled && id && result?.projects.some((p) => p.id === id)) void open(id); });
    return () => { cancelled = true; };
  }, [open, bridgeReady]);
  const back = () => { setProject(null); bindCanvasProject(null); history.replaceState(null, "", urlForWorkbench(location.href)); void load(); };
  if (!bridgeReady) return <main className="sg-app"><section className="sg-projects"><h1>无限画布</h1><p role="status">{bridgeError || "正在连接本地服务…"}</p>{bridgeError && <><button onClick={() => location.reload()}>重新连接</button><button onClick={() => { const url = new URL(location.href); url.searchParams.set("legacy", "1"); location.assign(url.href); }}>打开旧版工作台</button></>}</section></main>;
  return <main className="sg-app">
    <header className="sg-shell"><a className="sg-brand" href="#" onClick={(e) => { e.preventDefault(); setPage("library"); }}><span aria-hidden="true">∞</span> 图境 <small>CANVAS</small></a><nav aria-label="主导航"><button aria-current={page === "library" ? "page" : undefined} onClick={() => setPage("library")}>提示词库</button><button aria-current={page === "canvas" ? "page" : undefined} onClick={() => setPage("canvas")}>画布</button></nav><span className="sg-shell-note">少一些步骤，多一些表达。</span></header>
    {page === "library" && <PromptGallery onCanvas={() => setPage("canvas")} hasProject={!!project} />}
    {project && <SimpleCanvas key={project.id} projectId={project.id} projectName={project.name} onGallery={() => setPage("library")} onProjects={back} hidden={page !== "canvas"} />}
    {page === "canvas" && !project && <section className="sg-projects"><p className="sg-eyebrow">你的工作空间</p><h1>打开一个画布</h1><p>底图、提示词和每次生成的结果，都留在自己的项目里。</p><form onSubmit={(e) => { e.preventDefault(); setBusy(true); setError(""); void createWorkbenchProject(name).then((p) => open(p.id)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}><label htmlFor="new-project">新画布名称</label><div><input id="new-project" value={name} maxLength={80} placeholder="例如：产业园沿街效果" onChange={(e) => setName(e.target.value)} /><button className="sg-primary" disabled={!name.trim() || busy}>创建画布 ↗</button></div></form>{error && <p role="alert" className="sg-message sg-error">{error}<button onClick={() => void load()}>重新连接</button></p>}<div className="sg-project-list">{projects.map((p) => <button key={p.id} disabled={busy} onClick={() => void open(p.id)}><span><strong>{p.name}</strong><small>{p.imageNodes} 张图片 · {new Date(p.updatedAt).toLocaleDateString("zh-CN")}</small></span><span aria-hidden="true">↗</span></button>)}</div></section>}
  </main>;
}
