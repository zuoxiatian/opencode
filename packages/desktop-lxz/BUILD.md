# OpenCode Desktop 打包指南

本文档说明如何将 `desktop-lxz` 项目打包为 Windows 可执行文件 (EXE) 和 macOS 应用包。

## 目录

- [前置条件](#前置条件)
- [项目依赖关系](#项目依赖关系)
- [打包步骤](#打包步骤)
- [输出文件](#输出文件)
- [常见问题](#常见问题)

---

## 前置条件

### 系统要求

- **Node.js** >= 22
- **Bun** 1.3.5 (必须与 `package.json` 中的版本匹配)
- **npm** (用于运行 electron-vite 和 electron-builder)

### 检查环境

```powershell
# 检查 Node.js 版本
node --version

# 检查 Bun 版本 (必须为 1.3.5)
bun --version

# 检查 npm 版本
npm --version
```

---

## 项目依赖关系

打包 `desktop-lxz` 需要以下项目按顺序构建：

```
desktop-lxz (Electron 桌面应用)
    ├── @opencode-ai/sdk (SDK 接口 - Vite 构建时直接引用源码)
    │   └── packages/sdk/js/src
    └── opencode (后端服务 - 作为 extraResources 打包)
        ├── Windows: packages/desktop-lxz/bin/opencode.exe
        └── macOS: packages/desktop-lxz/bin/mac/{x64,arm64}/opencode
```

### 依赖说明

| 项目 | 路径 | 构建必要性 |
|------|------|------------|
| **opencode** | `packages/opencode` | ✅ 必须先构建，生成目标平台二进制 |
| **@opencode-ai/sdk** | `packages/sdk/js` | ⚪ 无需预编译，Vite 直接引用源码 |
| **desktop-lxz** | `packages/desktop-lxz` | ✅ 最后构建并打包 |

---

## 打包步骤

### 步骤 1: 安装依赖

在项目根目录安装所有依赖：

```powershell
cd C:\Users\82029\Desktop\工作\gitwork1\new_ai\open-code\opencode-dev
bun install
```

### 步骤 2: 构建 opencode 核心

> ⚠️ **重要**: 如果项目不是 Git 仓库，需要手动设置环境变量

```powershell
cd packages/opencode

# 设置环境变量并构建 (PowerShell)
$env:OPENCODE_CHANNEL="latest"
$env:OPENCODE_VERSION="1.1.25"  # 与 package.json 中的版本保持一致

# 使用 --single 参数只构建当前平台
bun run script/build.ts --single
```

构建完成后，将生成的二进制文件复制到 `desktop-lxz` 的 `bin` 目录：

```powershell
cd ..\..

# 创建 bin 目录（如果不存在）
if (!(Test-Path -Path "packages\desktop-lxz\bin")) { New-Item -ItemType Directory -Path "packages\desktop-lxz\bin" }

# 复制 Windows 二进制文件
Copy-Item -Path "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" -Destination "packages\desktop-lxz\bin\opencode.exe" -Force
```

### 步骤 3: 构建 desktop-lxz

```powershell
cd ../desktop-lxz

# 构建 Electron 应用 (main + preload + renderer)
npm run build
```

### 步骤 4: 打包为 EXE

```powershell
# 打包为安装程序和 ZIP
npm run dist

# 或者只打包为目录形式（不生成安装程序）
npm run pack
```

### 步骤 5: 打包 macOS

macOS 的 `dmg` 和 `zip` 需要在 macOS 机器上执行打包。先准备两个架构的后端二进制：

```bash
cd packages/opencode
OPENCODE_CHANNEL=latest OPENCODE_VERSION=1.1.25 bun run script/build.ts --skip-install

cd ../desktop-lxz
mkdir -p bin/mac/x64 bin/mac/arm64
cp ../opencode/dist/opencode-darwin-x64/bin/opencode bin/mac/x64/opencode
cp ../opencode/dist/opencode-darwin-arm64/bin/opencode bin/mac/arm64/opencode
chmod +x bin/mac/x64/opencode bin/mac/arm64/opencode

bun run build
bun run dist:mac
```

---

## 输出文件

打包完成后，文件位于 `packages/desktop-lxz/release/` 目录：

| 文件 | 说明 |
|------|------|
| `LongwiseTechAgent-{version}-win-x64-Installer.exe` | Windows NSIS 安装程序 |
| `LongwiseTechAgent-{version}-win-x64-Portable.exe` | Windows 便携版 |
| `LongwiseTechAgent-{version}-mac-x64.dmg` | macOS Intel DMG |
| `LongwiseTechAgent-{version}-mac-arm64.dmg` | macOS Apple Silicon DMG |
| `LongwiseTechAgent-{version}-mac-x64.zip` | macOS Intel ZIP |
| `LongwiseTechAgent-{version}-mac-arm64.zip` | macOS Apple Silicon ZIP |
| `win-unpacked/` | 解压后的应用目录 |
| `builder-debug.yml` | 构建调试信息 |

---

## 完整打包脚本

将以下脚本保存为 `build-desktop.ps1`，一键执行完整打包流程：

```powershell
#!/usr/bin/env pwsh

# OpenCode Desktop 构建脚本
# 使用方法: .\build-desktop.ps1

$ErrorActionPreference = "Stop"

$ROOT_DIR = "C:\Users\82029\Desktop\工作\gitwork1\new_ai\open-code\opencode-dev"
$OPENCODE_DIR = "$ROOT_DIR\packages\opencode"
$DESKTOP_DIR = "$ROOT_DIR\packages\desktop-lxz"

Write-Host "=== OpenCode Desktop 构建脚本 ===" -ForegroundColor Cyan

# 步骤 1: 构建 opencode
Write-Host "`n[1/3] 正在构建 opencode..." -ForegroundColor Yellow
Set-Location $OPENCODE_DIR

$env:OPENCODE_CHANNEL = "latest"
$env:OPENCODE_VERSION = "1.1.25"

bun run script/build.ts --single
if ($LASTEXITCODE -ne 0) { throw "opencode 构建失败" }

# 复制二进制文件
Set-Location $ROOT_DIR
if (!(Test-Path -Path "packages\desktop-lxz\bin")) { New-Item -ItemType Directory -Path "packages\desktop-lxz\bin" | Out-Null }
Copy-Item -Path "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" -Destination "packages\desktop-lxz\bin\opencode.exe" -Force
Write-Host "✓ opencode.exe 已生成" -ForegroundColor Green

# 步骤 2: 构建 desktop-lxz
Write-Host "`n[2/3] 正在构建 desktop-lxz..." -ForegroundColor Yellow
Set-Location $DESKTOP_DIR

npm run build
if ($LASTEXITCODE -ne 0) { throw "desktop-lxz 构建失败" }
Write-Host "✓ Electron 应用已构建" -ForegroundColor Green

# 步骤 3: 打包
Write-Host "`n[3/3] 正在打包为 EXE..." -ForegroundColor Yellow
npm run dist
if ($LASTEXITCODE -ne 0) { throw "打包失败" }

Write-Host "`n=== 打包完成 ===" -ForegroundColor Cyan
Write-Host "输出目录: $DESKTOP_DIR\release\" -ForegroundColor Green
Get-ChildItem "$DESKTOP_DIR\release" -File | Format-Table Name, @{N="Size(MB)";E={[math]::Round($_.Length/1MB,2)}}
```

---

## 常见问题

### 1. Bun 版本不匹配

**错误信息**: `This script requires bun@1.3.5, but you are using bun@x.x.x`

**解决方法**:
```powershell
npm install -g bun@1.3.5
```

### 2. Git 仓库未初始化

**错误信息**: `fatal: not a git repository`

**解决方法**: 手动设置环境变量
```powershell
$env:OPENCODE_CHANNEL = "latest"
$env:OPENCODE_VERSION = "1.1.25"
```

### 3. electron-builder 下载失败

**错误信息**: `Cannot download "https://github.com/electron/electron/releases/..."`

**解决方法**: 
- 检查网络连接
- 或设置国内镜像：
```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

### 4. 代码签名警告

**警告信息**: `no signing info identified, signing is skipped`

**说明**: 这是正常的，表示 EXE 没有进行代码签名。首次运行时 Windows 可能会显示安全警告。

**解决方法（可选）**: 如需正式发布，配置代码签名证书：
```json
// electron-builder.json
{
  "win": {
    "certificateFile": "path/to/certificate.pfx",
    "certificatePassword": "your-password"
  }
}
```

---

## 相关配置文件

| 文件 | 用途 |
|------|------|
| `electron-builder.json` | electron-builder 打包配置 |
| `electron.vite.config.ts` | electron-vite 构建配置 |
| `package.json` | 项目依赖和脚本 |

---

*最后更新: 2026-01-31*
