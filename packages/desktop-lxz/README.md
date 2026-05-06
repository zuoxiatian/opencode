# OpenCode Desktop (Electron + Vite)

基于 Electron + Vite 的桌面客户端。

## 开发

```bash
# 安装依赖
bun install

# 开发模式
bun run dev

# 构建
bun run build

# 预览构建结果
bun run preview
```

## 打包

```bash
# 仅打包（不创建安装程序）
bun run pack

# 创建安装程序
bun run dist
```

## 项目结构

```
src/
├── main/           # Electron 主进程
│   └── index.ts    # 启动服务器、创建窗口
│
├── preload/        # 预加载脚本
│   └── index.ts    # 暴露 IPC API
│
└── renderer/       # 渲染进程 (Vite + SolidJS)
    ├── index.tsx   # 应用入口
    ├── platform.ts # 平台适配层
    └── index.css   # 样式
```

## 架构

```
┌─────────────────────────────────────────┐
│ Electron Main Process                   │
│   - 启动 opencode CLI                   │
│   - 管理窗口                            │
│   - 处理 IPC                            │
└─────────────────────────────────────────┘
         │
         │ IPC (contextBridge)
         ▼
┌─────────────────────────────────────────┐
│ Renderer Process (Chromium)             │
│   - @opencode-ai/app UI                 │
│   - HTTP/WebSocket → OpenCode Server    │
└─────────────────────────────────────────┘
```
