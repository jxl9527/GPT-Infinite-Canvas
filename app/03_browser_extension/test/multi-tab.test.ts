import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import * as protocol from "../src/protocol.js";
import * as guards from "../src/background-guards.js";

test("真实后台逻辑：双网页独立绑定、错误结果拒收、完成不清空另一个任务、后台重启可恢复", async () => {
  const source = (await readFile(resolve("dist/background.js"), "utf8")).replace(/^import[\s\S]*?from ["'][^"']+["'];\s*/gm, "");
  const stored: Record<string, unknown> = { token: "test", apiRoot: "http://127.0.0.1:3220" };
  const tasks: Record<string, any> = Object.fromEntries(["a", "b"].map((id) => [`task_${id}`, { id: `task_${id}`, status: "queued", target: { chatMode: "new" }, simpleRender: { batchId: "simple_x" }, events: [], results: [] }]));
  const tabs = new Map<number, { id: number; url: string }>(); let nextTab = 10;
  let listener: (message: unknown, sender: unknown, reply: (value: any) => void) => unknown;
  const makeContext = () => {
    const chrome = {
      storage: { local: {
        get: async (keys: any) => keys === null ? structuredClone(stored) : typeof keys === "string" ? { [keys]: structuredClone(stored[keys]) } : { ...keys, ...structuredClone(stored) },
        set: async (values: any) => { Object.assign(stored, structuredClone(values)); },
        remove: async (key: string) => { delete stored[key]; }
      } },
      tabs: {
        create: async ({ url }: { url: string }) => { const tab = { id: nextTab++, url }; tabs.set(tab.id, tab); return tab; },
        get: async (id: number) => { const tab = tabs.get(id); if (!tab) throw new Error("closed"); return { ...tab }; },
        update: async (id: number, values: any) => { Object.assign(tabs.get(id)!, values); return tabs.get(id); },
        sendMessage: async () => undefined, onUpdated: { addListener: () => undefined }
      },
      runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } }
    };
    const context = vm.createContext({ ...protocol, ...guards, chrome, crypto: webcrypto, URL, AbortController, setTimeout, clearTimeout,
      fetch: async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/active")) return { ok: true, json: async () => ({ task: Object.values(tasks).find((task) => task.status !== "completed") }) };
        const id = path.split("/")[4]!; const task = tasks[id];
        if (path.endsWith("/claim")) task.status = "opening-chat";
        if (path.endsWith("/complete")) task.status = "completed";
        return { ok: true, json: async () => ({ task: structuredClone(task) }) };
      }
    });
    vm.runInContext(source, context);
  };
  const message = (payload: any, tab: { id: number; url: string }) => new Promise<any>((resolve) => listener(payload, { tab }, resolve));
  makeContext();
  const canvas = { id: 1, url: "http://127.0.0.1:3230/" };
  const [a, duplicate] = await Promise.all([message({ type: "canvas-run-task", taskId: "task_a" }, canvas), message({ type: "canvas-run-task", taskId: "task_a" }, canvas)]);
  assert.equal(a.ok, true); assert.equal(a.tabId, duplicate.tabId);
  tasks.task_a.submittedAt = "now";
  const b = await message({ type: "canvas-run-task", taskId: "task_b" }, canvas);
  assert.equal(b.ok, true); assert.notEqual(a.tabId, b.tabId); assert.equal(tabs.size, 2);
  const tabA = tabs.get(a.tabId)!; const tabB = tabs.get(b.tabId)!;
  assert.equal((await message({ type: "adapter-get-state" }, tabA)).task.id, "task_a");
  assert.equal((await message({ type: "adapter-get-state" }, tabB)).task.id, "task_b");
  const wrong = await message({ type: "adapter-event", taskId: "task_a", bindingId: a.bindingId, event: "completed" }, tabB);
  assert.equal(wrong.ok, false); assert.notEqual(tasks.task_a.status, "completed");
  makeContext();
  assert.equal((await message({ type: "adapter-get-state" }, tabB)).bindingId, b.bindingId);
  const done = await message({ type: "adapter-event", taskId: "task_b", bindingId: b.bindingId, event: "completed" }, tabB);
  assert.equal(done.ok, true);
  assert.equal((await message({ type: "adapter-get-state" }, tabA)).task.id, "task_a");
  tabs.delete(a.tabId);
  const missing = await message({ type: "canvas-run-task", taskId: "task_a" }, canvas);
  assert.equal(missing.ok, false); assert.match(missing.error, /不会重新发送/);
});
