import { TASK_START_OPTIONS } from "./task-start";
import type { WorkflowStage } from "./project-state";

export function TaskStartLauncher({
  onStart,
  onDismiss
}: {
  onStart(stage: Exclude<WorkflowStage, "completed">): void;
  onDismiss(): void;
}) {
  return (
    <section className="task-start-launcher" aria-labelledby="task-start-title">
      <header>
        <span>
          <small>NEW TASK</small>
          <h2 id="task-start-title">从当前要做的阶段开始</h2>
          <p>三个阶段互相独立。选择入口只设置本次任务，不会自动跨阶段。</p>
        </span>
        <button type="button" onClick={onDismiss}>先看空白画布</button>
      </header>
      <div>
        {TASK_START_OPTIONS.map((option) => (
          <button key={option.stage} type="button" onClick={() => onStart(option.stage)}>
            <small>{option.eyebrow}</small>
            <strong>{option.title}</strong>
            <span>{option.description}</span>
            <em>{option.inputHint}</em>
          </button>
        ))}
      </div>
      <footer>也可以直接拖入图片；系统不会修改或覆盖源文件。</footer>
    </section>
  );
}
