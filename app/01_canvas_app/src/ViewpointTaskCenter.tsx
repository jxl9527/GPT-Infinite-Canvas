import { useEffect, useMemo, useState } from "react";
import type { ImageNodeState } from "./canvas-layout";
import type {
  CandidateReviewCheck,
  CandidateReviewKey,
  CandidateReviewRecord
} from "./project-state";
import {
  CANDIDATE_REVIEW_LABELS,
  candidateReviewComplete,
  filterViewpointTasks,
  type ViewpointCandidateSummary,
  type ViewpointTaskFilter,
  type ViewpointTaskSummary
} from "./viewpoint-task-center";

const FILTER_LABELS: Readonly<Record<ViewpointTaskFilter, string>> = {
  all: "全部",
  attention: "需处理",
  review: "待验收",
  selected: "已采用",
  exported: "已导出"
};

const STATE_LABELS: Readonly<Record<ViewpointTaskSummary["state"], string>> = {
  idle: "待开始",
  attention: "需处理",
  review: "待验收",
  selected: "已采用",
  exported: "已导出"
};

const STAGE_LABELS: Readonly<Record<ViewpointTaskSummary["stage"], string>> = {
  preflight: "前置阶段",
  "scene-optimization": "优化阶段",
  "final-glass": "最终阶段",
  completed: "任务完成"
};

interface ViewpointTaskCenterProps {
  tasks: ViewpointTaskSummary[];
  nodes: ImageNodeState[];
  activeViewpointId: string | null;
  onActivateViewpoint(viewpointId: ViewpointTaskSummary["viewpointId"]): void;
  onFocusVersion(versionId: ViewpointCandidateSummary["versionId"]): void;
  onComparisonChange(versionIds: ViewpointCandidateSummary["versionId"][]): void;
  onPatchReview(
    viewpointId: ViewpointTaskSummary["viewpointId"],
    versionId: ViewpointCandidateSummary["versionId"],
    patch: Partial<CandidateReviewRecord>
  ): void;
  onApprove(viewpointId: ViewpointTaskSummary["viewpointId"], versionId: ViewpointCandidateSummary["versionId"]): void;
  onReject(viewpointId: ViewpointTaskSummary["viewpointId"], versionId: ViewpointCandidateSummary["versionId"]): void;
}

export function ViewpointTaskCenter({
  tasks,
  nodes,
  activeViewpointId,
  onActivateViewpoint,
  onFocusVersion,
  onComparisonChange,
  onPatchReview,
  onApprove,
  onReject
}: ViewpointTaskCenterProps) {
  const [filter, setFilter] = useState<ViewpointTaskFilter>("all");
  const [query, setQuery] = useState("");
  const [comparisonVersionIds, setComparisonVersionIds] = useState<ViewpointCandidateSummary["versionId"][]>([]);
  const [reviewVersionId, setReviewVersionId] = useState<ViewpointCandidateSummary["versionId"] | null>(null);
  const [zoom, setZoom] = useState(100);
  const visibleTasks = useMemo(() => filterViewpointTasks(tasks, filter, query), [filter, query, tasks]);
  const activeTask = tasks.find((task) => task.viewpointId === activeViewpointId) ?? visibleTasks[0] ?? tasks[0] ?? null;
  const nodesByVersion = useMemo(() => new Map(nodes.map((node) => [node.versionId, node])), [nodes]);
  const candidateKey = activeTask?.candidates.map((candidate) => candidate.versionId).join("|") ?? "";

  useEffect(() => {
    if (!activeTask) {
      setComparisonVersionIds([]);
      setReviewVersionId(null);
      onComparisonChange([]);
      return;
    }
    const candidates = activeTask.candidates.map((candidate) => candidate.versionId);
    const nextComparison = candidates.slice(0, 2);
    setComparisonVersionIds(nextComparison);
    setReviewVersionId(candidates[0] ?? null);
    setZoom(100);
    onComparisonChange(nextComparison);
  }, [activeTask?.viewpointId, candidateKey, onComparisonChange]);

  const reviewingCandidate = activeTask?.candidates.find((candidate) => candidate.versionId === reviewVersionId)
    ?? activeTask?.candidates[0]
    ?? null;
  const comparisonCandidates = comparisonVersionIds.flatMap((versionId) => {
    const candidate = activeTask?.candidates.find((item) => item.versionId === versionId);
    return candidate ? [candidate] : [];
  });

  const toggleComparison = (versionId: ViewpointCandidateSummary["versionId"]) => {
    const next = comparisonVersionIds.includes(versionId)
      ? comparisonVersionIds.filter((candidateId) => candidateId !== versionId)
      : [...comparisonVersionIds.slice(-1), versionId];
    setComparisonVersionIds(next);
    onComparisonChange(next);
  };

  const patchCheck = (key: CandidateReviewKey, state: Exclude<CandidateReviewCheck, "pending">) => {
    if (!activeTask || !reviewingCandidate) return;
    const current = reviewingCandidate.review.checks[key];
    onPatchReview(activeTask.viewpointId, reviewingCandidate.versionId, {
      checks: {
        ...reviewingCandidate.review.checks,
        [key]: current === state ? "pending" : state
      },
      decision: "pending"
    });
  };

  return (
    <section className="viewpoint-task-center" aria-label="视角任务中心">
      <header className="viewpoint-task-center-heading">
        <span>
          <small>VIEWPOINT REGISTER</small>
          <strong>视角任务中心</strong>
        </span>
        <div className="viewpoint-task-heading-actions">
          <dl>
            <div><dt>视角</dt><dd>{tasks.length}</dd></div>
            <div><dt>待验收</dt><dd>{tasks.filter((task) => task.state === "review").length}</dd></div>
            <div><dt>需处理</dt><dd>{tasks.filter((task) => task.state === "attention").length}</dd></div>
          </dl>
        </div>
      </header>

      <div className="viewpoint-task-toolbar">
        <label>
          <span className="visually-hidden">搜索视角、底图或候选</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索视角、底图或候选" />
        </label>
        <div role="radiogroup" aria-label="筛选视角任务">
          {(Object.keys(FILTER_LABELS) as ViewpointTaskFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={filter === value}
              data-active={filter === value}
              onClick={() => setFilter(value)}
            >{FILTER_LABELS[value]}</button>
          ))}
        </div>
      </div>

      <div className="viewpoint-task-layout">
        <nav className="viewpoint-task-list" aria-label="视角任务列表">
          {visibleTasks.length ? visibleTasks.map((task, index) => (
            <button
              key={task.viewpointId}
              type="button"
              data-active={task.viewpointId === activeTask?.viewpointId}
              data-state={task.state}
              onClick={() => onActivateViewpoint(task.viewpointId)}
            >
              <b>{String(index + 1).padStart(2, "0")}</b>
              <span>
                <strong>{task.name}</strong>
                <small>{STAGE_LABELS[task.stage]} · {task.sourceName}</small>
              </span>
              <em>{STATE_LABELS[task.state]}</em>
              <span className="viewpoint-task-metrics" aria-label={`候选 ${task.candidateCount}，已验收 ${task.reviewedCount}，风险 ${task.riskCount}`}>
                <span>候选 <b>{task.candidateCount}</b></span>
                <span>已验收 <b>{task.reviewedCount}</b></span>
                <span>风险 <b>{task.riskCount}</b></span>
              </span>
            </button>
          )) : (
            <div className="viewpoint-task-empty">
              <strong>{tasks.length ? "没有符合条件的视角" : "还没有视角任务"}</strong>
              <p>{tasks.length ? "清除筛选或换一个关键词。" : "从任意阶段直接开始；导入图片后，系统会按视角整理底图、提示词和候选版本。"}</p>
              {tasks.length > 0 && <button type="button" onClick={() => { setFilter("all"); setQuery(""); }}>显示全部</button>}
            </div>
          )}
        </nav>

        <div className="candidate-review-workspace">
          {activeTask ? (
            <>
              <header className="candidate-review-heading">
                <span>
                  <small>{STAGE_LABELS[activeTask.stage]}</small>
                  <strong>{activeTask.name}</strong>
                  <p>{activeTask.nextAction}</p>
                </span>
                <em>{activeTask.candidateCount} 个候选</em>
              </header>

              {activeTask.candidates.length ? (
                <>
                  <div className="candidate-picker" aria-label="选择对比候选">
                    {activeTask.candidates.map((candidate) => (
                      <div key={candidate.versionId} data-risk={Boolean(candidate.riskMessage)} data-selected={candidate.selected}>
                        <label>
                          <input
                            type="checkbox"
                            checked={comparisonVersionIds.includes(candidate.versionId)}
                            onChange={() => toggleComparison(candidate.versionId)}
                          />
                          <span>
                            <strong>{candidate.displayName}</strong>
                            <small>{candidate.selected ? "已采用" : candidate.riskMessage ? "需复核" : candidate.review.decision === "approved" ? "验收通过" : "待验收"}</small>
                          </span>
                        </label>
                        <button type="button" onClick={() => { setReviewVersionId(candidate.versionId); onFocusVersion(candidate.versionId); }}>检查</button>
                      </div>
                    ))}
                  </div>

                  <section className="candidate-comparison" aria-label="候选同步对比">
                    <header>
                      <span><strong>同步对比</strong><small>最多两张 · 同步缩放 · 原图不修改</small></span>
                      <label><span>放大</span><input type="range" min="100" max="220" step="10" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><em>{zoom}%</em></label>
                    </header>
                    <div data-count={comparisonCandidates.length}>
                      {comparisonCandidates.map((candidate) => {
                        const node = nodesByVersion.get(candidate.versionId);
                        return (
                          <figure key={candidate.versionId} data-risk={Boolean(candidate.riskMessage)}>
                            <div>{node?.src ? <img src={node.src} alt={candidate.displayName} style={{ transform: `scale(${zoom / 100})` }} /> : <span>正在读取候选预览…</span>}</div>
                            <figcaption><strong>{candidate.displayName}</strong><small>{candidate.riskMessage || candidate.sourceName}</small></figcaption>
                          </figure>
                        );
                      })}
                      {!comparisonCandidates.length && <p>勾选一至两个候选进行同步对比。</p>}
                    </div>
                  </section>

                  {reviewingCandidate && (
                    <section className="candidate-checklist" aria-label={`验收 ${reviewingCandidate.displayName}`}>
                      <header>
                        <span><small>人工验收</small><strong>{reviewingCandidate.displayName}</strong></span>
                        <em data-decision={reviewingCandidate.review.decision}>{reviewingCandidate.selected ? "已采用" : reviewingCandidate.review.decision === "approved" ? "已通过" : reviewingCandidate.review.decision === "rejected" ? "已拒绝" : "待判断"}</em>
                      </header>
                      {reviewingCandidate.riskMessage && <p className="candidate-risk-note"><b>结构风险提示</b>{reviewingCandidate.riskMessage}</p>}
                      <div className="candidate-check-rows">
                        {(Object.keys(CANDIDATE_REVIEW_LABELS) as CandidateReviewKey[]).map((key, index) => (
                          <div key={key} data-state={reviewingCandidate.review.checks[key]}>
                            <b>{String(index + 1).padStart(2, "0")}</b>
                            <span><strong>{CANDIDATE_REVIEW_LABELS[key]}</strong><small>{reviewingCandidate.review.checks[key] === "passed" ? "符合结构依据" : reviewingCandidate.review.checks[key] === "failed" ? "发现偏差" : "尚未检查"}</small></span>
                            <button type="button" data-active={reviewingCandidate.review.checks[key] === "passed"} onClick={() => patchCheck(key, "passed")}>通过</button>
                            <button type="button" data-active={reviewingCandidate.review.checks[key] === "failed"} onClick={() => patchCheck(key, "failed")}>问题</button>
                          </div>
                        ))}
                      </div>
                      <label className="candidate-review-note">
                        <span>验收备注</span>
                        <textarea
                          value={reviewingCandidate.review.note}
                          maxLength={1000}
                          rows={3}
                          placeholder="记录结构偏差、需补生位置或采用理由。"
                          onChange={(event) => onPatchReview(activeTask.viewpointId, reviewingCandidate.versionId, { note: event.target.value })}
                        />
                      </label>
                      <footer>
                        <button type="button" className="candidate-reject" onClick={() => onReject(activeTask.viewpointId, reviewingCandidate.versionId)}>拒绝并保留记录</button>
                        <button type="button" className="candidate-approve" disabled={!candidateReviewComplete(reviewingCandidate.review)} onClick={() => onApprove(activeTask.viewpointId, reviewingCandidate.versionId)}>五项通过并采用</button>
                      </footer>
                    </section>
                  )}
                </>
              ) : (
                <div className="candidate-review-empty">
                  <strong>当前视角尚无候选版本</strong>
                  <p>{activeTask.nextAction}</p>
                </div>
              )}

              <details className="viewpoint-help">
                <summary>输入角色说明</summary>
                <dl>
                  <div><dt>结构底图</dt><dd>唯一建筑、道路、场地和构图依据，不能被风格参考替代。</dd></div>
                  <div><dt>风格参考</dt><dd>只提供色彩、材质、光影和氛围，不提供建筑造型。</dd></div>
                  <div><dt>最终完整图</dt><dd>最终阶段只使用完整 D5 图深化玻璃，不上传蒙版或通道图。</dd></div>
                </dl>
              </details>
            </>
          ) : (
            <div className="candidate-review-empty"><strong>选择一个视角开始</strong><p>任务中心会把底图、提示词、候选和采用结果放在同一条视角记录中。</p></div>
          )}
        </div>
      </div>
    </section>
  );
}
