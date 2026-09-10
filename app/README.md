# 应用源码

GPT Infinite Canvas 采用 TypeScript monorepo：

| 目录 | 职责 |
|---|---|
| `01_canvas_app` | React 无限画布、批注、版本关系与任务预览 |
| `02_bridge_service` | 仅监听本机的桥接服务、项目数据与结果回收 |
| `03_browser_extension` | ChatGPT 网页任务发送与结果检测；Flow 实验适配冻结保留 |
| `04_shared_packages` | 共享类型、任务协议、错误码与校验工具 |
| `05_installer_and_ops` | Windows 启停、备份、恢复与诊断 |

常用命令：

```powershell
npm install
npm run build
npm run build:canvas
npm test
```

本地运行数据写入 `runtime/`，不会纳入 Git。
