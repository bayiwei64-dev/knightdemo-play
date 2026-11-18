const get = (id) => document.getElementById(id);
const stage = get("stage");
const status = get("game-status");
const cover = get("game-cover");
const kicker = get("cover-kicker");
const hint = get("game-hint");
const start = get("start");
const cancel = get("cancel-load");
const progress = get("load-progress");
const exit = get("leave");
const fullscreen = get("fullscreen");
const reel = get("reel");
const reelStatus = get("reel-status");
const player = get("play");
const base = new URL("./game/", document.baseURI);
const launchManifest = "launch-r2.json";
const idleMs = 30_000;

let canvas = get("game");
let instance;
let loader;
let load;
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

function deadline(work, ms, message) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

function loadScript(src) {
  if (loader) return loader;
  if (typeof window.createUnityInstance === "function") return Promise.resolve();
  const script = document.createElement("script");
  script.src = src;
  const loaded = new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error("Unity loader could not be loaded."));
    document.head.append(script);
  });
  loader = deadline(loaded, idleMs, "Unity loader download timed out.").catch(error => {
    loader = null;
    script.remove();
    throw error;
  });
  return loader;
}

async function readPart(part, signal, onBytes, retry = false) {
  const request = new AbortController();
  const abort = () => request.abort(signal.reason);
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  let timer;
  function watch() {
    clearTimeout(timer);
    timer = setTimeout(() => request.abort(new Error(`No data received: ${part.path}`)), idleMs);
  }

  try {
    watch();
    // Part paths are immutable per release. Retain completed parts when a user retries.
    const reply = await fetch(new URL(part.path, base), {
      signal: request.signal, cache: retry ? "reload" : "force-cache"
    });
    if (!reply.ok || !reply.body) throw new Error(`HTTP ${reply.status}: ${part.path}`);
    const reader = reply.body.getReader();
    const bytes = new Uint8Array(part.bytes);
    let pos = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watch();
      bytes.set(value, pos);
      pos += value.length;
      onBytes(pos);
    }
    if (pos !== bytes.length) throw new Error(`Incomplete game file: ${part.path}`);
    return new Blob([bytes]);
  } catch (error) {
    request.abort();
    onBytes(0);
    signal.throwIfAborted();
    if (!retry) return readPart(part, signal, onBytes, true);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function loadPlayerFiles(build, signal) {
  const parts = [...build.dataParts, ...build.codeParts];
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  const received = new Uint32Array(parts.length);
  const bodies = new Array(parts.length);
  const mb = (bytes) => (bytes / 1024 ** 2).toFixed(1);
  let next = 0;
  const show = () => {
    const bytes = received.reduce((sum, value) => sum + value, 0);
    const percent = Math.floor(bytes / total * 100);
    progress.value = 0.95 * bytes / total;
    const text = `下载游戏资源 ${percent}% · ${mb(bytes)} / ${mb(total)} MiB`;
    if (hint.textContent !== text) hint.textContent = text;
  };
  show();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!signal.aborted && next < parts.length) {
      const index = next++;
      bodies[index] = await readPart(parts[index], signal, bytes => {
        received[index] = bytes;
        show();
      });
    }
  }));
  signal.throwIfAborted();
  const split = build.dataParts.length;
  return [new Blob(bodies.slice(0, split)), new Blob(bodies.slice(split))];
}

function banner(message, type) {
  if (type === "error") console.error(message);
  else console.warn(message);
}

function resetStage(afterPlay) {
  stage.style.removeProperty("height");
  if (afterPlay) {
    const replacement = canvas.cloneNode(false);
    replacement.removeAttribute("style");
    replacement.width = 1280;
    replacement.height = 720;
    replacement.hidden = true;
    canvas.replaceWith(replacement);
    canvas = replacement;
    connectCanvas(canvas);
  }
  state = "ready";
  status.textContent = "准备就绪";
  stage.classList.remove("is-running");
  cover.hidden = false;
  kicker.textContent = "王国边缘 · 二见黄蜂女";
  start.textContent = afterPlay ? "重新试玩" : "开始试玩";
  start.disabled = false;
  hint.textContent = afterPlay ? "从主菜单开始新的挑战。" : "已取消下载，可以随时重新开始。";
  progress.hidden = cancel.hidden = true;
  setControls(false);
  start.focus({ preventScroll: true });
}

async function launch() {
  if (state === "reload") { location.reload(); return; }
  if (state !== "ready") return;
  reel.pause();
  state = "loading";
  const controller = load = new AbortController();
  player.setAttribute("aria-busy", "true");
  start.textContent = "正在加载";
  start.disabled = true;
  status.textContent = "正在下载游戏";
  kicker.textContent = "准备进入王国边缘";
  progress.value = 0;
  progress.hidden = cancel.hidden = false;
  hint.textContent = "正在连接游戏资源…";
  let startingUnity = false;
  let unsupported = false;
  const objects = [];
  try {
    if (!window.WebAssembly || !window.WebGL2RenderingContext) {
      unsupported = true;
      throw new Error("WebAssembly or WebGL 2 is unavailable.");
    }
    const build = await deadline(fetch(new URL(launchManifest, base), {
      signal: controller.signal, cache: "no-cache"
    }).then(reply => {
      if (!reply.ok) throw new Error(`Unity launch manifest: HTTP ${reply.status}`);
      return reply.json();
    }), idleMs, "Unity launch manifest download timed out.");
    const url = key => new URL(build[key], base).href;
    const [, [data, code]] = await Promise.all([
      loadScript(url("loaderUrl")),
      loadPlayerFiles(build, controller.signal)
    ]);
    controller.signal.throwIfAborted();
    objects.push(URL.createObjectURL(data), URL.createObjectURL(code));
    cancel.hidden = true;
    startingUnity = true;
    status.textContent = "正在启动游戏";
    progress.value = 0.95;
    hint.textContent = "资源已下载，正在启动 Unity…";
    canvas.hidden = false;
    const starting = window.createUnityInstance(canvas, {
      dataUrl: objects[0],
      frameworkUrl: url("frameworkUrl"),
      codeUrl: objects[1],
      streamingAssetsUrl: url("streamingAssetsUrl"),
      companyName: "KnightDemo",
      productName: "KnightDemo",
      productVersion: "1.0",
      showBanner: banner,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 1.5)
    }, () => {});
    try {
      instance = await deadline(starting, 60_000, "Unity did not finish starting.");
    } catch (error) {
      starting.then(late => late.Quit()).catch(() => {});
      throw error;
    }
    state = "playing";
    status.textContent = "试玩中";
    stage.classList.add("is-running");
    cover.hidden = true;
    setControls(true);
    canvas.focus({ preventScroll: true });
  } catch (error) {
    if (controller.signal.aborted) { resetStage(false); return; }
    controller.abort();
    console.error("KnightDemo Web could not start:", error);
    state = startingUnity ? "reload" : "ready";
    canvas.hidden = true;
    status.textContent = "未能启动";
    kicker.textContent = startingUnity || unsupported ? "游戏未能启动" : "游戏资源下载中断";
    start.textContent = startingUnity ? "重新加载网页" : "重试加载";
    start.disabled = false;
    progress.hidden = cancel.hidden = true;
    hint.textContent = startingUnity || unsupported
      ? "请用支持 WebGL 2 的电脑 Chrome 或 Edge。也可先看下方实机视频。"
      : "可以重试，已下载的文件会优先复用。也可先看下方实机视频。";
  } finally {
    load = null;
    for (const object of objects) URL.revokeObjectURL(object);
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
    resetStage(true);
  } catch (error) {
    console.error("KnightDemo Web could not close:", error);
    location.reload();
  } finally {
    exit.disabled = fullscreen.disabled = false;
  }
}

start.addEventListener("click", launch);
cancel.addEventListener("click", () => load?.abort());
exit.addEventListener("click", stop);
fullscreen.addEventListener("click", () => {
  if (state === "playing" && instance) {
    canvas.focus({ preventScroll: true });
    instance.SetFullscreen(1);
  }
});
window.addEventListener("knightdemo:exit", () => setTimeout(stop, 0));

let reelTimer;
const reelRetry = get("reel-retry");
function setReelStatus(message = "", offerRetry = false) {
  reelStatus.textContent = message;
  reelStatus.hidden = !message;
  reelRetry.hidden = !offerRetry;
}
function clearReelTimer() {
  clearTimeout(reelTimer);
  reelTimer = undefined;
}
function waitForVideo(message) {
  if (reelTimer || !reelRetry.hidden) return;
  setReelStatus(message);
  reelTimer = setTimeout(() => {
    clearReelTimer();
    setReelStatus("视频加载较慢，可重试播放或直接打开 MP4。", true);
  }, 12_000);
}
function showVideoError(message) {
  clearReelTimer();
  setReelStatus(message, true);
}
function playReel(restart) {
  if (restart || reel.error) reel.load();
  clearReelTimer();
  setReelStatus();
  waitForVideo("正在加载视频…");
  reel.play().catch(error => {
    if (error.name === "AbortError") return;
    showVideoError(error.name === "NotAllowedError"
      ? "请点击播放器的播放按钮，或直接打开 MP4。"
      : "视频未能加载，可重试播放或直接打开 MP4。");
  });
}
get("watch-link").addEventListener("click", () => playReel(!reelRetry.hidden));
reelRetry.addEventListener("click", () => playReel(true));
function syncReelAudio() {
  if (state === "playing" && instance)
    instance.SendMessage("KnightWebRuntime", "SetReelPlaying", reel.paused || reel.ended ? "0" : "1");
}
for (const event of ["play", "pause", "ended"]) reel.addEventListener(event, syncReelAudio);
reel.addEventListener("playing", () => { clearReelTimer(); setReelStatus(); });
reel.addEventListener("pause", () => {
  if (reel.paused && !reel.error && reelRetry.hidden) { clearReelTimer(); setReelStatus(); }
});
reel.addEventListener("waiting", () => { if (!reel.paused) waitForVideo("正在缓冲视频…"); });
reel.addEventListener("error", () => showVideoError("视频未能加载，可重试播放或直接打开 MP4。"));
document.querySelector(".play-again").addEventListener("click", () => {
  if (state === "playing") canvas.focus({ preventScroll: true });
});
