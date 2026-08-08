# 画布整体迁移记录

- 迁移时间：2026-08-04 11:37（Asia/Shanghai）
- 原位置：`D:\OneDrive - St Paulinus Catholic Primary School\GPT画布`
- 新位置：`D:\OneDrive - 静超科技\D5-AI-Pipeline\canvas`
- 迁移方式：复制迁入，原目录保留不动

## 已迁入

- React 无限画布源码与测试
- 本地桥接服务源码与测试
- Chrome 浏览器扩展源码
- 安装、启动、诊断与打包脚本
- 项目文档、Git 历史及当前未提交工作区
- `default-project`、3 个工作台项目、图片资产、批注、任务和日志

## 重建内容

- 未复制旧 `node_modules`、`dist`、`.test-dist` 和 TypeScript 构建缓存
- 在新目录依据 `package-lock.json` 执行 `npm ci`
- 在新目录重新生成画布、桥接服务和浏览器扩展构建产物

## 验证结果

- 共享协议：3 项测试通过
- 桥接服务：15 项测试通过
- 浏览器扩展：11 项测试通过
- 画布应用：54 项测试通过
- 合计：83 项测试通过
- 原 D5 Python 管线：18 项 `unittest` 测试通过
- 迁移项目数据：除新服务正常追加的 `workbench\logs\bridge.jsonl` 外，153 个项目文件的路径、大小和 SHA-256 完全一致
- 新服务：`http://127.0.0.1:3220/health` 正常
- 新画布：`http://127.0.0.1:3230/` 返回 HTTP 200
- 桌面“GPT 无限画布”快捷方式已指向新目录；旧快捷方式已备份

## 未自动处理

- `npm ci` 报告 1 个中等级依赖告警，未自动执行可能改变依赖树的 `npm audit fix`
- Chrome 已解压扩展的来源目录需要在扩展管理页改为新目录：`D:\OneDrive - 静超科技\D5-AI-Pipeline\canvas\app\03_browser_extension\dist`
