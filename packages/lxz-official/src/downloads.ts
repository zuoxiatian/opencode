type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    architecture?: string
    platform?: string
  }
}

export const releases = [
  {
    version: "1.0.0",
    date: "2026-05-25",
    label: "首个稳定桌面版",
    summary: "集成本地桌面壳、内置 opencode 后端，提供 macOS 与 Windows 安装包。",
    notes: ["新增桌面安装包", "内置运行时与后端服务", "支持 macOS Apple Silicon / Intel 双架构"],
    files: [
      {
        id: "win-x64-zip",
        os: "Windows",
        arch: "x64",
        format: "ZIP",
        filename: "LongwiseTechAgent-1.0.0-win-x64.zip",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-1.0.0-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-zip",
        os: "macOS",
        arch: "Intel",
        format: "ZIP",
        filename: "LongwiseTechAgent-1.0.0-mac-x64.zip",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.9.3",
    date: "2026-05-18",
    label: "桌面版候选发布",
    summary: "完善安装包命名和桌面启动流程。",
    notes: ["优化安装包", "更新启动流程"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.9.3-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.3-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.3-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.9.2",
    date: "2026-05-11",
    label: "桌面版测试发布",
    summary: "调整内置运行时和后端服务打包。",
    notes: ["更新运行时", "修复打包流程"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.9.2-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.2-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.2-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.9.1",
    date: "2026-05-04",
    label: "桌面版预览发布",
    summary: "增加 macOS 双架构安装包。",
    notes: ["新增 macOS Intel 包", "调整下载体验"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.9.1-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.1-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.1-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.9.0",
    date: "2026-04-27",
    label: "桌面版预览发布",
    summary: "提供首批桌面预览安装包。",
    notes: ["新增 Windows 安装包", "新增 macOS Apple Silicon 包"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.9.0-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.0-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.9.0-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.8.4",
    date: "2026-04-20",
    label: "桌面版内部测试",
    summary: "修复安装流程和资源路径。",
    notes: ["修复资源路径", "更新安装脚本"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.8.4-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.4-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.4-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.8.3",
    date: "2026-04-13",
    label: "桌面版内部测试",
    summary: "优化下载页识别逻辑。",
    notes: ["优化平台识别", "调整下载链接"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.8.3-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.3-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.3-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.8.2",
    date: "2026-04-06",
    label: "桌面版内部测试",
    summary: "调整教程页和历史版本结构。",
    notes: ["调整教程页", "更新版本列表"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.8.2-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.2-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.2-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
  {
    version: "0.8.1",
    date: "2026-03-30",
    label: "桌面版内部测试",
    summary: "补充 macOS 安装教程资源。",
    notes: ["新增教程资源", "更新版本数据"],
    files: [
      {
        id: "win-x64-installer",
        os: "Windows",
        arch: "x64",
        format: "安装程序",
        filename: "LongwiseTechAgent-0.8.1-win-x64-Installer.exe",
        hint: "推荐给大多数 Windows 电脑",
      },
      {
        id: "mac-arm64-dmg",
        os: "macOS",
        arch: "Apple Silicon",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.1-mac-arm64.dmg",
        hint: "适合 M 系列 Mac",
      },
      {
        id: "mac-x64-dmg",
        os: "macOS",
        arch: "Intel",
        format: "DMG",
        filename: "LongwiseTechAgent-0.8.1-mac-x64.dmg",
        hint: "适合 Intel Mac",
      },
    ],
  },
] as const

export type ReleaseFile = (typeof releases)[number]["files"][number]

export function buildDownloadUrl(filename: string) {
  return `${(import.meta.env.VITE_DOWNLOAD_BASE_URL || `${import.meta.env.BASE_URL.replace(/\/$/, "")}/downloads`).replace(/\/$/, "")}/${filename}`
}

export function getDeviceDownload(navigatorValue: Navigator) {
  const navigatorWithData = navigatorValue as NavigatorWithUserAgentData
  const platformValue =
    `${navigatorWithData.userAgentData?.platform || navigatorWithData.platform || ""} ${navigatorWithData.userAgent}`.toLowerCase()
  const archValue = `${navigatorWithData.userAgentData?.architecture || ""} ${navigatorWithData.userAgent}`.toLowerCase()
  const isIntel = archValue.includes("x86") || archValue.includes("x64") || archValue.includes("amd64") || archValue.includes("intel")
  const os = platformValue.includes("mac") ? "macOS" : "Windows"
  const arch = os === "macOS" ? (isIntel ? "Intel" : "Apple Silicon") : "x64"
  const file = releases[0].files.find((item) => item.os === os && item.arch === arch) || releases[0].files[0]

  return {
    arch,
    file,
    os,
    url: buildDownloadUrl(file.filename),
  }
}
