✨ LongwiseTechAgent 1.0.0 稳定版正式发布！

- [新增] Windows 桌面客户端首发，登录后即可进入桌面端工作流。
- [新增] 项目文件夹管理：支持添加、切换、移除项目文件夹，并可一键在资源管理器中打开本地目录。
- [新增] 会话管理能力：支持按项目保存会话历史，新建、重命名、删除会话，并同步展示会话状态与未读提醒。
- [新增] AI 对话工作流：支持选择 Agent 模式和模型、流式回复、任务中止、权限确认，以及多轮问题回答。
- [新增] 技能市场：支持查看市场技能和已安装技能，提供搜索、安装、更新、删除能力，并自动同步必装技能。
- [新增] 账号登录与模型配置同步：登录后自动拉取模型配置并写入本地客户端配置，减少手动配置成本。
- [新增] 客户端更新检查：支持启动时检查和手动检查新版本，并兼容必需更新提示。
- [优化] 桌面端体验：支持跟随系统、亮色、暗色主题，统一窗口标题栏、设置面板和状态提示。

/uploads/client/win/x64/stable/1.0.0/
/uploads/client/win/x64/stable/1.0.0/



{
  "model": "newapi/kimi-k2.6",
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "newapi": {
      "npm": "@ai-sdk/anthropic",
      "models": {
        "kimi-k2.6": {
          "name": "LongwiseTechLLM",
          "limit": {
            "input": 32768,
            "output": 4096,
            "context": 32768
          }
        }
      },
      "options": {
        "apiKey": "{env:NEWAPI_API_KEY}",
        "baseURL": "http://121.40.17.69:3000/v1"
      }
    }
  },
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 8192,
    "tail_turns": 2,
    "preserve_recent_tokens": 6000
  },
  "disabled_providers": [
    "opencode"
  ]
}





{
  "model": "newapi/kimi-k2.6",
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "newapi": {
      "npm": "@ai-sdk/anthropic",
      "models": {
        "kimi-k2.6": {
          "name": "LongwiseTechLLM",
          "limit": {
            "input": 229376,
            "output": 32768,
            "context": 262144
          }
        }
      },
      "options": {
        "apiKey": "__MODEL_API_KEY__",
        "baseURL": "http://121.40.17.69:3000/v1"
      }
    }
  },
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 8192,
    "tail_turns": 2,
    "preserve_recent_tokens": 6000
  },
  "disabled_providers": [
    "opencode"
  ]
}



{
  "model": "newapi/kimi-k2.6",
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "newapi": {
      "npm": "@ai-sdk/anthropic",
      "models": {
        "kimi-k2.6": {
          "name": "LongwiseTechLLM",
          "limit": {
            "input": 32768,
            "output": 4096,
            "context": 32768
          }
        }
      },
      "options": {
        "apiKey": "__MODEL_API_KEY__",
        "baseURL": "http://121.40.17.69:3000/v1"
      }
    }
  },
  "disabled_providers": [
    "opencode"
  ]
}