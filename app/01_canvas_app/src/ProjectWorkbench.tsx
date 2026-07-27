import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent
} from "react";
import {
  activateWorkbenchProject,
  connectCanvasSession,
  createWorkbenchProject,
  listWorkbenchProjects,
  previewProjectRequirements,
  type ProjectRequirementsPreview,
  type WorkbenchProject
} from "./bridge-client";

interface ProjectWorkbenchProps {
  onOpen(project: WorkbenchProject): void;
}

function projectDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "尚未保存"
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function ProjectWorkbench({ onOpen }: ProjectWorkbenchProps) {
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [parsingRequirements, setParsingRequirements] = useState(false);
  const [requirementsContent, setRequirementsContent] = useState("");
  const [requirementsPreview, setRequirementsPreview] = useState<ProjectRequirementsPreview | null>(null);
  const [error, setError] = useState("");
  const requirementsInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await connectCanvasSession();
      const result = await listWorkbenchProjects();
      setProjects(result.projects);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取项目列表");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (project: WorkbenchProject) => {
    if (busyProjectId || creating) return;
    setBusyProjectId(project.id);
    setError("");
    try {
      onOpen(await activateWorkbenchProject(project.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目打开失败");
      setBusyProjectId(null);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const projectName = name.trim();
    if (!projectName || creating || busyProjectId) return;
    setCreating(true);
    setError("");
    try {
      const requirements = requirementsPreview && requirementsContent
        ? {
            sourceName: requirementsPreview.sourceName,
            content: requirementsContent
          }
        : undefined;
      const project = await createWorkbenchProject(projectName, requirements);
      onOpen(await activateWorkbenchProject(project.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败");
      setCreating(false);
    }
  };

  const readRequirements = async (file: File | undefined) => {
    if (!file || parsingRequirements || creating) return;
    setParsingRequirements(true);
    setError("");
    setRequirementsPreview(null);
    setRequirementsContent("");
    try {
      const result = await previewProjectRequirements(file);
      setRequirementsContent(result.content);
      setRequirementsPreview(result.preview);
      if (!name.trim() && result.preview.projectNameSuggestion) {
        setName(result.preview.projectNameSuggestion);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目需求 Markdown 读取失败");
    } finally {
      setParsingRequirements(false);
      if (requirementsInputRef.current) requirementsInputRef.current.value = "";
    }
  };

  const onRequirementsChange = (event: ChangeEvent<HTMLInputElement>) => {
    void readRequirements(event.target.files?.[0]);
  };

  const onRequirementsDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void readRequirements(event.dataTransfer.files?.[0]);
  };

  return (
    <main className="workbench-shell">
      <div className="workbench-grid" aria-hidden="true" />

      <section className="workbench-intro" aria-labelledby="workbench-title">
        <span className="workbench-index">望岳 / 杜甫</span>
        <h1 id="workbench-title">造化钟神秀，<br />阴阳割昏晓。<br />会当凌绝顶，<br />一览众山小。</h1>
      </section>

      <section className="project-ledger" aria-label="项目列表">
        <div className="project-ledger-heading">
          <div>
            <span>PROJECT REGISTER</span>
            <h2>项目登记簿</h2>
          </div>
          <button type="button" className="workbench-refresh" onClick={() => void load()} disabled={loading}>
            {loading ? "读取中" : "刷新"}
          </button>
        </div>

        <form className="new-project-line" onSubmit={(event) => void create(event)}>
          <div className="new-project-heading">
            <div>
              <span>NEW PROJECT</span>
              <strong>新建项目</strong>
            </div>
            <small>可直接建立空白画布，也可先导入项目需求</small>
          </div>
          <label htmlFor="new-project-name">项目名称</label>
          <div className="project-name-entry">
            <input
              id="new-project-name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：德清木业产业园投标方案"
              autoComplete="off"
            />
          </div>

          <div
            className="requirements-picker"
            data-ready={Boolean(requirementsPreview)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onRequirementsDrop}
          >
            <input
              ref={requirementsInputRef}
              className="visually-hidden"
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              onChange={onRequirementsChange}
            />
            <div className="requirements-picker-intro">
              <span aria-hidden="true">MD</span>
              <div>
                <strong>
                  {parsingRequirements
                    ? "正在提取项目背景…"
                    : requirementsPreview
                      ? requirementsPreview.sourceName
                      : "导入项目需求 Markdown"}
                </strong>
                <small>
                  {requirementsPreview
                    ? `${requirementsPreview.characterCount.toLocaleString("zh-CN")} 字符 · 识别 ${requirementsPreview.recognizedSectionCount} 个章节`
                    : "可选：拖入文件，或从电脑中选择 .md / .markdown"}
                </small>
              </div>
              <button
                type="button"
                className="requirements-select"
                onClick={() => requirementsInputRef.current?.click()}
                disabled={parsingRequirements || creating}
              >
                {requirementsPreview ? "重新选择" : "选择文件"}
              </button>
            </div>

            {requirementsPreview && (
              <div className="requirements-preview" aria-live="polite">
                <div>
                  <span>提取摘要</span>
                  <p>{requirementsPreview.summary || "已读取文档，但未提取到可显示的摘要。"}</p>
                </div>
                <div className="requirements-sections" aria-label="已识别章节">
                  {requirementsPreview.sections
                    .filter((section) => section.key !== "other")
                    .slice(0, 8)
                    .map((section) => <span key={`${section.key}-${section.heading}`}>{section.label}</span>)}
                </div>
                {requirementsPreview.missingRecommended.length > 0 && (
                  <p className="requirements-warning">
                    建议补充：{requirementsPreview.missingRecommended.join("、")}。不影响创建，后续生图将使用已识别内容。
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="new-project-submit">
            <span>
              {requirementsPreview
                ? "确认后复制源文件，并生成项目级背景与约束上下文。"
                : "无需准备需求文档，也可以先创建空白项目并导入图片。"}
            </span>
            <button
              type="submit"
              disabled={!name.trim() || creating}
            >
              {creating
                ? "正在创建…"
                : requirementsPreview
                  ? "带项目背景创建"
                  : "创建空白项目"}
            </button>
          </div>
        </form>

        {error && <p className="workbench-error" role="alert">{error}</p>}

        <div className="project-list" data-loading={loading}>
          {!loading && projects.length === 0 && (
            <div className="project-empty">
              <strong>还没有项目</strong>
              <span>在上方上传项目需求 Markdown，创建第一张独立画布。</span>
            </div>
          )}
          {projects.map((project, index) => (
            <article className="project-row" key={project.id}>
              <span className="project-number">{String(index + 1).padStart(2, "0")}</span>
              <div className="project-name">
                <h3>{project.name}</h3>
                <span>{project.relativeLocation}</span>
                <small data-ready={Boolean(project.requirements)}>
                  {project.requirements
                    ? `${project.requirements.sourceName} · ${project.requirements.sectionCount} 节`
                    : "历史项目 · 尚无项目需求文档"}
                </small>
              </div>
              <dl>
                <div><dt>图片</dt><dd>{project.imageNodes}</dd></div>
                <div><dt>批注</dt><dd>{project.annotations}</dd></div>
                <div><dt>版本</dt><dd>R{project.revision}</dd></div>
                <div><dt>更新</dt><dd>{projectDate(project.updatedAt)}</dd></div>
              </dl>
              <button
                type="button"
                onClick={() => void open(project)}
                disabled={Boolean(busyProjectId) || creating}
              >
                {busyProjectId === project.id ? "正在打开…" : "进入项目"}
              </button>
            </article>
          ))}
        </div>
      </section>

      <footer className="workbench-footer">
        <span>WORKSPACE 127.0.0.1</span>
        <span>项目切换前必须完成当前生成任务</span>
      </footer>
    </main>
  );
}
