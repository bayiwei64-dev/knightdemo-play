const get = (id) => document.getElementById(id);
const stage = get("stage");
const status = get("game-status");
const cover = get("game-cover");
const kicker = get("cover-kicker");
const hint = get("game-hint");
const start = get("start");
const progress = get("load-progress");
const exit = get("leave");
const fullscreen = get("fullscreen");
const reel = get("reel");
const player = get("play");
const base = new URL("./game/", document.baseURI);

let canvas = get("game");
let instance;
let config;
let state = "ready";

function connectCanvas(el) {
  el.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code))
      event.preventDefault();
  });
}

connectCanvas(canvas);

function setControls(playing) {
  exit.hidden = fullscreen.hidden = !playing;
  get("desktop-label").hidden = playing;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Unity loader could not be loaded."));
    document.head.append(script);
  });
}

async function loadConfig() {
  if (config) return config;
  const reply = await fetch(new URL("build.json", base), { cache: "no-cache" });
  if (!reply.ok) throw new Error("Unity build manifest is missing.");
  config = await reply.json();
  return config;
}

function banner(message, type) {
  if (type === "error") console.error(message);
  else console.warn(message);
}

function resetStage() {
  stage.style.removeProperty("height");
  const replacement = canvas.cloneNode(false);
  replacement.removeAttribute("style");
  replacement.width = 1280;
  replacement.height = 720;
  replacement.hidden = true;
  canvas.replaceWith(replacement);
  canvas = replacement;
  connectCanvas(canvas);
  state = "ready";
  status.textContent = "准备就绪";
  stage.classList.remove("is-running");
  cover.hidden = false;
  kicker.textContent = "王国边缘 · 二见黄蜂女";
  start.textContent = "重新试玩";
  start.disabled = false;
  hint.textContent = "从主菜单开始新的挑战。";
  progress.hidden = true;
  setControls(false);
  start.focus({ preventScroll: true });
}

async function launch() {
  if (state === "failed") {
    location.reload();
    return;
  }
  if (state !== "ready") return;
  reel.pause();
  state = "loading";
  player.setAttribute("aria-busy", "true");
  start.disabled = true;
  start.textContent = "正在加载";
  status.textContent = "正在加载游戏";
  kicker.textContent = "准备进入王国边缘";
  progress.value = 0;
  progress.hidden = false;
  hint.textContent = "首次加载游戏资源，请稍候。";
  try {
    if (!window.WebAssembly) throw new Error("WebAssembly is unavailable.");
    const build = await loadConfig();
    if (typeof window.createUnityInstance !== "function")
      await loadScript(new URL(build.loaderUrl, base));
    const url = (key) => new URL(build[key], base).href;
    canvas.hidden = false;
    instance = await window.createUnityInstance(canvas, {
      dataUrl: url("dataUrl"),
      frameworkUrl: url("frameworkUrl"),
      codeUrl: url("codeUrl"),
      streamingAssetsUrl: url("streamingAssetsUrl"),
      companyName: "KnightDemo",
      productName: "KnightDemo",
      productVersion: "1.0",
      showBanner: banner,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 1.5)
    }, (ratio) => {
      progress.value = ratio;
      hint.textContent = "游戏加载 " + Math.floor(ratio * 100) + "%";
    });
    state = "playing";
    status.textContent = "试玩中";
    stage.classList.add("is-running");
    cover.hidden = true;
    setControls(true);
    canvas.focus({ preventScroll: true });
  } catch (error) {
    console.error("KnightDemo Web could not start:", error);
    state = "failed";
    canvas.hidden = true;
    status.textContent = "未能启动";
    kicker.textContent = "游戏未能启动";
    start.textContent = "重新加载";
    start.disabled = false;
    progress.hidden = true;
    hint.textContent = "请在支持 WebGL 2 的电脑 Chrome 或 Edge 中重试。";
  } finally {
    player.removeAttribute("aria-busy");
  }
}

async function stop() {
  if (state !== "playing" || !instance) return;
  state = "leaving";
  exit.disabled = fullscreen.disabled = true;
  status.textContent = "正在结束试玩";
  try {
    await instance.Quit();
    instance = null;
    resetStage();
  } catch (error) {
    console.error("KnightDemo Web could not close:", error);
    location.reload();
  } finally {
    exit.disabled = fullscreen.disabled = false;
  }
}

start.addEventListener("click", launch);
exit.addEventListener("click", stop);
fullscreen.addEventListener("click", () => {
  if (state === "playing" && instance) {
    canvas.focus({ preventScroll: true });
    instance.SetFullscreen(1);
  }
});
window.addEventListener("knightdemo:exit", () => setTimeout(stop, 0));
get("watch-link").addEventListener("click", () => { reel.play().catch(() => {}); });
function syncReelAudio() {
  if (state === "playing" && instance)
    instance.SendMessage("KnightWebRuntime", "SetReelPlaying", reel.paused || reel.ended ? "0" : "1");
}
for (const event of ["play", "pause", "ended"]) reel.addEventListener(event, syncReelAudio);
document.querySelector(".play-again").addEventListener("click", () => {
  if (state === "playing") canvas.focus({ preventScroll: true });
});
reel.addEventListener("error", () => {
  const caption = document.querySelector(".reel-caption");
  const file = document.createElement("a");
  file.href = reel.currentSrc || reel.src;
  file.textContent = "直接打开 MP4";
  caption.replaceChildren("播放器未能读取视频，可", file, "。");
});
