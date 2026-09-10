import assert from "node:assert/strict";
import test from "node:test";
import { projectIdFromUrl, urlForProject, urlForWorkbench } from "../src/project-route.js";

test("项目地址在刷新后保留当前项目标识", () => {
  const projectId = "project_7b47dd5c-951f-4743-a7f7-858f289d9431";
  const nextUrl = urlForProject("http://127.0.0.1:3230/", projectId);
  assert.equal(nextUrl, `/?project=${projectId}`);
  assert.equal(projectIdFromUrl(`http://127.0.0.1:3230${nextUrl}`), projectId);
});

test("无效项目标识不会触发自动打开", () => {
  assert.equal(projectIdFromUrl("http://127.0.0.1:3230/?project=../../runtime"), null);
  assert.equal(urlForProject("http://127.0.0.1:3230/?project=old", "invalid"), "/");
});

test("返回项目列表时清除项目标识并保留其他地址状态", () => {
  assert.equal(
    urlForWorkbench("http://127.0.0.1:3230/?project=project_demo&panel=registry#projects"),
    "/?panel=registry#projects"
  );
  assert.equal(projectIdFromUrl("http://127.0.0.1:3230/?panel=registry#projects"), null);
});
