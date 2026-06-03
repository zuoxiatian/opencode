import { createSignal, For, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import { buildDownloadUrl, getDeviceDownload, releases } from "./downloads"
import "./index.css"

const latest = releases[0]
const recommended = getDeviceDownload(navigator)
const assetBase = import.meta.env.BASE_URL
const macDownloads = latest.files
  .filter((file) => file.os === "macOS")
  .sort((file) => (file.arch === "Apple Silicon" ? -1 : 1))
const windowsDownload = latest.files.find((file) => file.os === "Windows") || latest.files[0]
const tutorials = [
  {
    id: "mac",
    label: "macOS 客户端安装教程",
    meta: "DMG 安装、拖入 Applications、首次启动确认",
    video: `${assetBase}tutorials/mac-install.mov`,
    poster: `${assetBase}tutorials/mac-install-poster.svg`,
  },
]

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00"
  const minutes = Math.floor(seconds / 60)
  return `${minutes.toString().padStart(2, "0")}:${Math.floor(seconds - minutes * 60)
    .toString()
    .padStart(2, "0")}`
}
function MicrosoftIcon() {
  return (
    <svg class="brand-svg microsoft-svg" viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" />
      <path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  )
}

function AppleIcon() {
  return (
    <svg class="brand-svg apple-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.091zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.701z" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg class="download-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v11m0 0 4.5-4.5M12 14 7.5 9.5M5 17.5v1.25A2.25 2.25 0 0 0 7.25 21h9.5A2.25 2.25 0 0 0 19 18.75V17.5"
        fill="none"
        stroke="currentColor"
        stroke-width="2.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg class="player-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8.25 6.78c0-.95 1.05-1.52 1.84-1l8.12 5.22c.7.45.7 1.55 0 2l-8.12 5.22c-.79.52-1.84-.05-1.84-1V6.78z"
        fill="currentColor"
      />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg class="player-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z" fill="currentColor" />
    </svg>
  )
}

function VolumeIcon(props: { muted: boolean }) {
  return (
    <svg class="player-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.75 9.25v5.5h3.1l4.65 3.75v-13L7.85 9.25h-3.1z"
        fill="none"
        stroke="currentColor"
        stroke-linejoin="round"
        stroke-width="2"
      />
      {props.muted ? (
        <path
          d="m17 9 4 4m0-4-4 4"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-width="2"
        />
      ) : (
        <path
          d="M16.25 8.25a5.1 5.1 0 0 1 0 7.5"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-width="2"
        />
      )}
    </svg>
  )
}

function FullscreenIcon(props: { active: boolean }) {
  return (
    <svg class="player-svg" viewBox="0 0 24 24" aria-hidden="true">
      {props.active ? (
        <path
          d="M9 4.75v4.5h-4.5M15 4.75v4.5h4.5M9 19.25v-4.5h-4.5M15 19.25v-4.5h4.5"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
        />
      ) : (
        <path
          d="M4.75 9.25v-4.5h4.5M19.25 9.25v-4.5h-4.5M4.75 14.75v4.5h4.5M19.25 14.75v4.5h-4.5"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
        />
      )}
    </svg>
  )
}

function App() {
  const [selectedTutorial, setSelectedTutorial] = createSignal(tutorials[0])
  const [currentTime, setCurrentTime] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [isFullscreen, setIsFullscreen] = createSignal(false)
  const [isMuted, setIsMuted] = createSignal(false)
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [posterVisible, setPosterVisible] = createSignal(true)
  const [controlsVisible, setControlsVisible] = createSignal(false)
  const progressPercent = () => (duration() ? Math.min((currentTime() / duration()) * 100, 100) : 0)
  const rangeValue = () => (duration() ? Math.round((currentTime() / duration()) * 1000) : 0)
  let controlsHideTimer: number | undefined
  let player: HTMLDivElement | undefined
  let video: HTMLVideoElement | undefined
  const clearControlsHideTimer = () => {
    if (controlsHideTimer === undefined) return
    window.clearTimeout(controlsHideTimer)
    controlsHideTimer = undefined
  }
  const hideControlsLater = (delay = 2200) => {
    clearControlsHideTimer()
    controlsHideTimer = window.setTimeout(() => setControlsVisible(false), delay)
  }
  const showControls = () => {
    setControlsVisible(true)
    if (!video || video.paused) {
      clearControlsHideTimer()
      return
    }
    hideControlsLater()
  }
  const keepControlsVisible = () => {
    setControlsVisible(true)
    clearControlsHideTimer()
  }
  const syncVideoState = () => {
    if (!video) return
    setCurrentTime(video.currentTime)
    setDuration(video.duration || 0)
    setIsMuted(video.muted)
    setIsPlaying(!video.paused)
  }
  const togglePlayback = () => {
    if (!video) return
    if (!video.paused) {
      video.pause()
      keepControlsVisible()
      return
    }
    void video.play().then(showControls).catch(keepControlsVisible)
  }
  const seekVideo = (value: number) => {
    if (!video || !duration()) return
    video.currentTime = (value / 1000) * duration()
    setCurrentTime(video.currentTime)
  }
  const toggleMute = () => {
    if (!video) return
    video.muted = !video.muted
    setIsMuted(video.muted)
  }
  const toggleFullscreen = () => {
    if (!player) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    void player.requestFullscreen()
  }

  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) =>
        entries
          .filter((entry) => entry.isIntersecting)
          .forEach((entry) => {
            entry.target.classList.add("is-visible")
            observer.unobserve(entry.target)
          }),
      { threshold: 0.16 },
    )
    const stageObserver = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.target.classList.toggle("is-current", entry.isIntersecting)),
      { threshold: 0.56 },
    )
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === player)

    document.querySelectorAll(".reveal, .client-option, .tutorial-video-card").forEach((item) => observer.observe(item))
    document.querySelectorAll("main > section").forEach((item) => stageObserver.observe(item))
    document.addEventListener("fullscreenchange", syncFullscreenState)

    onCleanup(() => {
      observer.disconnect()
      stageObserver.disconnect()
      clearControlsHideTimer()
      document.removeEventListener("fullscreenchange", syncFullscreenState)
    })
  })

  return (
    <>
      <header class="site-header">
        <a class="brand" href="#top" aria-label="LongwiseTechAgent 首页">
          <img class="brand-mark" src={`${assetBase}logo.png`} alt="" aria-hidden="true" />
          <span>LongwiseTechAgent</span>
        </a>
        <nav aria-label="主导航">
          <a href="#download">客户端</a>
          <a href="#guide">安装指南</a>
          <a href="#versions">历史版本</a>
        </nav>
      </header>

      <main>
        <section class="hero is-current" id="top">
          <div class="mesh mesh-one"></div>
          <div class="mesh mesh-two"></div>
          <div class="hero-shell">
            <p class="hero-label">Official desktop release</p>
            <h1>
              LongwiseTech
              <br />
              <span>Agent</span>
            </h1>
            <div class="hero-actions">
              <a class="download-pill" href={recommended.url} download={recommended.file.filename}>
                下载 {recommended.os} 版
              </a>
              <a class="learn-link" href="#guide">
                安装指南
              </a>
            </div>
          </div>
          <div class="hero-visual" aria-hidden="true">
            <img src={`${assetBase}hero-app-preview.svg`} alt="" />
          </div>
        </section>

        <section class="download-section reveal" id="download">
          <div class="section-heading download-heading">
            <h2>桌面客户端</h2>
            <span>支持 Windows 和 macOS 桌面端</span>
          </div>
          <div class="download-center">
            <div class="platform-downloads">
              <a
                class="platform-tile platform-win"
                href={buildDownloadUrl(windowsDownload.filename)}
                download={windowsDownload.filename}
                aria-label="下载 Windows 版"
              >
                <span class="platform-icon-card" aria-hidden="true">
                  <span class="tile-face tile-face-main">
                    <MicrosoftIcon />
                  </span>
                  <span class="tile-face tile-face-download">
                    <DownloadIcon />
                    <small>点击下载</small>
                  </span>
                </span>
                <strong>Windows</strong>
              </a>
              <article class="platform-tile mac-tile" tabIndex={0}>
                <span class="platform-icon-card">
                  <span class="tile-face tile-face-main">
                    <AppleIcon />
                  </span>
                  <span class="tile-face tile-face-options">
                    <For each={macDownloads}>
                      {(file) => (
                        <a href={buildDownloadUrl(file.filename)} download={file.filename}>
                          <span>{file.arch === "Apple Silicon" ? "Apple" : file.arch} 版本</span>
                          <DownloadIcon />
                        </a>
                      )}
                    </For>
                  </span>
                </span>
                <strong>macOS</strong>
              </article>
            </div>
          </div>
        </section>

        <section class="content-section guide-section reveal" id="guide">
          <div class="tutorial-panel">
            <div class="client-picker" aria-label="安装教程" role="tablist">
              <For each={tutorials}>
                {(item) => (
                  <button
                    classList={{ "client-option": true, active: selectedTutorial().id === item.id }}
                    type="button"
                    role="tab"
                    aria-selected={selectedTutorial().id === item.id}
                    data-tutorial={item.id}
                    onClick={() => {
                      setSelectedTutorial(item)
                      setCurrentTime(0)
                      setDuration(0)
                      setIsPlaying(false)
                      setPosterVisible(true)
                      keepControlsVisible()
                      queueMicrotask(() => {
                        video?.load()
                        syncVideoState()
                      })
                    }}
                  >
                    <strong>{item.label}</strong>
                  </button>
                )}
              </For>
            </div>
            <article class="tutorial-video-card">
              <div class="video-frame">
                <div
                  classList={{ "video-player": true, "is-playing": isPlaying(), "controls-visible": controlsVisible() }}
                  ref={player}
                  onFocusIn={keepControlsVisible}
                  onMouseEnter={showControls}
                  onMouseLeave={() => hideControlsLater(1400)}
                  onMouseMove={showControls}
                  onTouchStart={showControls}
                >
                  <video
                    preload="metadata"
                    poster={selectedTutorial().poster}
                    playsinline
                    data-video
                    ref={video}
                    onClick={togglePlayback}
                    onDurationChange={syncVideoState}
                    onEnded={() => {
                      setIsPlaying(false)
                      setPosterVisible(true)
                      keepControlsVisible()
                    }}
                    onLoadedMetadata={syncVideoState}
                    onPause={() => {
                      setIsPlaying(false)
                      keepControlsVisible()
                    }}
                    onPlay={() => {
                      setIsPlaying(true)
                      setPosterVisible(false)
                      showControls()
                    }}
                    onTimeUpdate={syncVideoState}
                    onVolumeChange={syncVideoState}
                  >
                    <source src={selectedTutorial().video} data-video-source />
                    当前浏览器不支持视频播放。
                  </video>
                  <button
                    classList={{ "video-poster": true, "is-hidden": !posterVisible() }}
                    type="button"
                    aria-label="播放安装教程"
                    onClick={togglePlayback}
                  >
                    <img src={selectedTutorial().poster} alt="" />
                  </button>
                  <button
                    class="player-center-button"
                    type="button"
                    aria-label={isPlaying() ? "暂停视频" : "播放视频"}
                    onClick={togglePlayback}
                  >
                    {isPlaying() ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <div class="player-controls" aria-label="视频控制">
                    <button
                      class="player-button player-button-primary"
                      type="button"
                      aria-label={isPlaying() ? "暂停视频" : "播放视频"}
                      onClick={togglePlayback}
                    >
                      {isPlaying() ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <input
                      class="player-timeline"
                      type="range"
                      min="0"
                      max="1000"
                      value={rangeValue()}
                      style={{ "--progress": `${progressPercent()}%` }}
                      aria-label="播放进度"
                      onInput={(event) => {
                        keepControlsVisible()
                        seekVideo(Number(event.currentTarget.value))
                      }}
                    />
                    <span class="player-time">
                      {formatTime(currentTime())} / {formatTime(duration())}
                    </span>
                    <button
                      class="player-button"
                      type="button"
                      aria-label={isMuted() ? "取消静音" : "静音"}
                      onClick={toggleMute}
                    >
                      <VolumeIcon muted={isMuted()} />
                    </button>
                    <button
                      class="player-button"
                      type="button"
                      aria-label={isFullscreen() ? "退出全屏" : "全屏播放"}
                      onClick={toggleFullscreen}
                    >
                      <FullscreenIcon active={isFullscreen()} />
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section class="content-section versions-section reveal" id="versions">
          <div class="section-heading">
            <h2>历史版本</h2>
          </div>
          <div class="version-list-shell">
            <div class="version-list">
              <For each={releases}>
                {(release) => (
                  <article>
                    <div class="version-meta">
                      <strong>v{release.version}</strong>
                      <time datetime={release.date}>{release.date}</time>
                    </div>
                    <div class="version-downloads">
                      <For each={release.files}>
                        {(file) => (
                          <a href={buildDownloadUrl(file.filename)} download={file.filename}>
                            {file.os} {file.arch}
                          </a>
                        )}
                      </For>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </div>
        </section>
      </main>
    </>
  )
}

render(() => <App />, document.getElementById("root")!)
